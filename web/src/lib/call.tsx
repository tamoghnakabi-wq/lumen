import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { get } from "./api.ts";
import { getSocket } from "./socket.ts";
import { useAuth } from "./auth.tsx";
import type { UserCard } from "./types.ts";

/**
 * One-to-one audio and video calling over WebRTC.
 *
 * Media is peer-to-peer; the server only relays the handshake over the socket
 * that is already authenticated, so calling inherits the app's existing
 * identity, blocking and presence rules rather than inventing its own.
 *
 * A video call is the same peer connection with a camera track attached, chosen
 * once when the call starts. Turning the camera off during a call disables that
 * track rather than removing it, so neither side has to renegotiate mid-call.
 */

export type CallPhase = "idle" | "outgoing" | "incoming" | "connecting" | "active" | "ended";
export type CallKind = "audio" | "video";

export type CallState = {
  phase: CallPhase;
  callId: string | null;
  peer: UserCard | null;
  conversationId: string | null;
  kind: CallKind;
  muted: boolean;
  /** Your own camera, off either by choice or because none was available. */
  cameraOff: boolean;
  /** True once the peer's video track is actually producing frames. */
  remoteVideo: boolean;
  /** Milliseconds since the call was answered, ticking while active. */
  elapsedMs: number;
  error: string | null;
  /** Set when the media path dropped and we are trying to recover it. */
  reconnecting: boolean;
};

type CallApi = CallState & {
  startCall: (conversationId: string, peer: UserCard, kind?: CallKind) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  /** Attaches the local and remote streams to the overlay's video elements. */
  attachVideo: (which: "local" | "remote", el: HTMLVideoElement | null) => void;
  dismissError: () => void;
};

const CallContext = createContext<CallApi | null>(null);

const IDLE: CallState = {
  phase: "idle",
  callId: null,
  peer: null,
  conversationId: null,
  kind: "audio",
  muted: false,
  cameraOff: false,
  remoteVideo: false,
  elapsedMs: 0,
  error: null,
  reconnecting: false,
};

function describeEnd(reason: string): string | null {
  switch (reason) {
    case "declined":
      return "Call declined";
    case "missed":
      return "No answer";
    case "cancelled":
      return "Call cancelled";
    case "failed":
      return "The call could not connect";
    case "disconnected":
      return "The other person lost connection";
    default:
      return null;
  }
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [state, setState] = useState<CallState>(IDLE);

  const pc = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  /** The remote MediaStream, held so a <video> can attach whenever it mounts. */
  const remoteStream = useRef<MediaStream | null>(null);
  const localVideoEl = useRef<HTMLVideoElement | null>(null);
  const remoteVideoEl = useRef<HTMLVideoElement | null>(null);
  const kindRef = useRef<CallKind>("audio");
  /**
   * Whether the peer says their camera is on. Disabling a track keeps the RTP
   * flowing as black frames, so the receiver's track never reports itself muted
   * — the only reliable signal is the peer telling us, which rides the existing
   * relay as an ordinary opaque payload.
   */
  const remoteCameraOn = useRef(true);
  /** Set by createPeer so a camera signal can re-run the same calculation. */
  const syncRemoteVideo = useRef<(() => void) | null>(null);
  const ringtone = useRef<{ stop: () => void } | null>(null);
  const answeredAt = useRef<number | null>(null);
  const callIdRef = useRef<string | null>(null);
  const iceConfig = useRef<RTCConfiguration | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const restarted = useRef(false);
  /**
   * createPeer is memoised with no deps, so anything it closes over — including
   * `recover` — sees the state from first render, where the phase is always
   * "idle". Reading the phase through a ref is what makes the recovery path
   * below reachable at all.
   */
  const phaseRef = useRef<CallPhase>("idle");

  /* ------------------------------------------------------------ teardown */

  const cleanupMedia = useCallback(() => {
    pc.current?.getSenders().forEach((s) => s.track?.stop());
    pc.current?.close();
    pc.current = null;
    localStream.current?.getTracks().forEach((t) => t.stop());
    localStream.current = null;
    if (remoteAudio.current) {
      remoteAudio.current.srcObject = null;
      remoteAudio.current.remove();
      remoteAudio.current = null;
    }
    remoteStream.current = null;
    remoteCameraOn.current = true;
    syncRemoteVideo.current = null;
    for (const el of [localVideoEl.current, remoteVideoEl.current]) {
      if (el) el.srcObject = null;
    }
    pendingCandidates.current = [];
    answeredAt.current = null;
    restarted.current = false;
  }, []);

  const stopRingtone = useCallback(() => {
    ringtone.current?.stop();
    ringtone.current = null;
  }, []);

  const reset = useCallback(
    (error: string | null = null) => {
      cleanupMedia();
      stopRingtone();
      callIdRef.current = null;
      setState({ ...IDLE, error });
    },
    [cleanupMedia, stopRingtone],
  );

  /* --------------------------------------------------------- media setup */

  const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" };

  /**
   * Captures the tracks a call of this kind needs.
   *
   * A video call falls back to audio only if the camera is unavailable — losing
   * the picture is a much smaller failure than dropping the call, and the other
   * side simply sees no video.
   */
  async function getLocalMedia(kind: CallKind): Promise<{ stream: MediaStream; cameraOff: boolean }> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot access your microphone or camera.");
    }
    const describe = (err: unknown, what: string) => {
      const name = (err as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        return new Error(`${what} access was blocked. Allow it in your browser settings to make calls.`);
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        return new Error(`No ${what.toLowerCase()} was found on this device.`);
      }
      return new Error(`Could not start your ${what.toLowerCase()}.`);
    };

    if (kind === "video") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: VIDEO_CONSTRAINTS });
        return { stream, cameraOff: false };
      } catch (err) {
        const name = (err as DOMException)?.name;
        // No camera at all: carry on with audio rather than refusing the call.
        if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") {
          const stream = await navigator.mediaDevices
            .getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false })
            .catch((e) => { throw describe(e, "Microphone"); });
          return { stream, cameraOff: true };
        }
        throw describe(err, "Camera");
      }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
      return { stream, cameraOff: true };
    } catch (err) {
      throw describe(err, "Microphone");
    }
  }

  async function loadIceConfig(): Promise<RTCConfiguration> {
    if (iceConfig.current) return iceConfig.current;
    try {
      const data = await get<{ iceServers: RTCIceServer[] }>("/calls/ice");
      iceConfig.current = { iceServers: data.iceServers };
    } catch {
      // Still usable on a local network without any STUN at all.
      iceConfig.current = { iceServers: [] };
    }
    return iceConfig.current;
  }

  const createPeer = useCallback(
    async (callId: string, stream: MediaStream) => {
      const socket = getSocket();
      const connection = new RTCPeerConnection(await loadIceConfig());
      pc.current = connection;

      for (const track of stream.getTracks()) connection.addTrack(track, stream);

      connection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("call:signal", { callId, data: { candidate: event.candidate.toJSON() } });
        }
      };

      connection.ontrack = (event) => {
        const stream = event.streams[0];
        remoteStream.current = stream;

        // Audio plays from a detached element so it keeps working on screens
        // that render no video at all.
        let el = remoteAudio.current;
        if (!el) {
          el = new Audio();
          el.autoplay = true;
          remoteAudio.current = el;
        }
        el.srcObject = stream;
        void el.play().catch(() => {});

        if (remoteVideoEl.current) {
          remoteVideoEl.current.srcObject = stream;
          void remoteVideoEl.current.play().catch(() => {});
        }

        // Whether the peer is actually sending pictures, which is not the same
        // as having asked for a video call: their camera may be off or absent.
        const sync = () => {
          const live =
            remoteCameraOn.current &&
            stream.getVideoTracks().some((track) => track.readyState === "live" && !track.muted);
          setState((s) => (s.remoteVideo === live ? s : { ...s, remoteVideo: live }));
        };
        syncRemoteVideo.current = sync;
        sync();
        for (const track of stream.getVideoTracks()) {
          track.addEventListener("mute", sync);
          track.addEventListener("unmute", sync);
          track.addEventListener("ended", sync);
        }
      };

      connection.onconnectionstatechange = () => {
        const status = connection.connectionState;
        if (status === "connected") {
          answeredAt.current ??= Date.now();
          setState((s) => ({ ...s, phase: "active", reconnecting: false }));
          // Tell the peer where our camera stands, so someone who joined a video
          // call without one is shown as camera-off rather than a black frame.
          const hasCamera = (localStream.current?.getVideoTracks() ?? []).some((tr) => tr.enabled);
          socket.emit("call:signal", { callId, data: { camera: hasCamera } });
        } else if (status === "disconnected") {
          // Often transient — a network blip. Give ICE a chance to recover.
          setState((s) => (s.phase === "active" ? { ...s, reconnecting: true } : s));
        } else if (status === "failed") {
          void recover(callId);
        }
      };

      return connection;
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /**
   * One ICE restart attempt before giving up. Only the caller renegotiates, so
   * the two sides cannot both try to take the lead at once.
   */
  async function recover(callId: string) {
    const connection = pc.current;
    const socket = getSocket();
    if (!connection || restarted.current || phaseRef.current !== "active") {
      socket.emit("call:failure", { callId });
      return;
    }
    restarted.current = true;
    setState((s) => ({ ...s, reconnecting: true }));
    try {
      const offer = await connection.createOffer({ iceRestart: true });
      await connection.setLocalDescription(offer);
      socket.emit("call:signal", { callId, data: { sdp: connection.localDescription } });
    } catch {
      socket.emit("call:failure", { callId });
    }
  }

  /* ------------------------------------------------------------- actions */

  const startCall = useCallback(
    async (conversationId: string, peer: UserCard, kind: CallKind = "audio") => {
      if (state.phase !== "idle" && state.phase !== "ended") return;
      kindRef.current = kind;
      setState({ ...IDLE, phase: "outgoing", peer, conversationId, kind });
      try {
        // Ask for the devices before ringing, so a permission problem surfaces
        // immediately instead of after the other person picks up.
        const { stream, cameraOff } = await getLocalMedia(kind);
        localStream.current = stream;
        attachLocalPreview(stream);
        setState((s) => ({ ...s, cameraOff }));
      } catch (err) {
        reset(err instanceof Error ? err.message : "Could not start your microphone.");
        return;
      }
      getSocket().emit("call:start", { conversationId, kind });
    },
    [reset, state.phase],
  );

  const accept = useCallback(async () => {
    const callId = callIdRef.current;
    if (!callId || state.phase !== "incoming") return;
    stopRingtone();
    setState((s) => ({ ...s, phase: "connecting" }));
    try {
      const { stream, cameraOff } = await getLocalMedia(kindRef.current);
      localStream.current = stream;
      attachLocalPreview(stream);
      setState((s) => ({ ...s, cameraOff }));
    } catch (err) {
      getSocket().emit("call:hangup", { callId });
      reset(err instanceof Error ? err.message : "Could not start your microphone.");
      return;
    }
    await createPeer(callId, localStream.current);
    getSocket().emit("call:accept", { callId });
  }, [createPeer, reset, state.phase, stopRingtone]);

  const decline = useCallback(() => {
    const callId = callIdRef.current;
    if (callId) getSocket().emit("call:decline", { callId });
    reset();
  }, [reset]);

  const hangUp = useCallback(() => {
    const callId = callIdRef.current;
    if (callId) getSocket().emit("call:hangup", { callId });
    reset();
  }, [reset]);

  const toggleMute = useCallback(() => {
    const tracks = localStream.current?.getAudioTracks() ?? [];
    const next = !state.muted;
    for (const track of tracks) track.enabled = !next;
    setState((s) => ({ ...s, muted: next }));
  }, [state.muted]);

  /**
   * Turns your camera on or off by enabling the track rather than removing it.
   * Removing a track means renegotiating mid-call; disabling it sends black
   * frames the peer reads as muted, which is the same result for far less risk.
   */
  const announceCamera = useCallback((on: boolean) => {
    const callId = callIdRef.current;
    if (callId) getSocket().emit("call:signal", { callId, data: { camera: on } });
  }, []);

  const toggleCamera = useCallback(() => {
    const tracks = localStream.current?.getVideoTracks() ?? [];
    if (tracks.length === 0) return;
    const next = !state.cameraOff;
    for (const track of tracks) track.enabled = !next;
    setState((s) => ({ ...s, cameraOff: next }));
    announceCamera(!next);
  }, [state.cameraOff, announceCamera]);

  function attachLocalPreview(stream: MediaStream) {
    if (!localVideoEl.current) return;
    localVideoEl.current.srcObject = stream;
    void localVideoEl.current.play().catch(() => {});
  }

  /** The overlay hands its <video> elements over as they mount and unmount. */
  const attachVideo = useCallback((which: "local" | "remote", el: HTMLVideoElement | null) => {
    if (which === "local") {
      localVideoEl.current = el;
      if (el && localStream.current) {
        el.srcObject = localStream.current;
        void el.play().catch(() => {});
      }
    } else {
      remoteVideoEl.current = el;
      if (el && remoteStream.current) {
        el.srcObject = remoteStream.current;
        void el.play().catch(() => {});
      }
    }
  }, []);

  const dismissError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  /* -------------------------------------------------------- socket wiring */

  useEffect(() => {
    if (!user) return;
    const socket = getSocket();

    const onIncoming = (p: { callId: string; conversationId: string; kind?: CallKind; from: UserCard | null }) => {
      // Already busy locally: let the server-side busy check own the response.
      if (callIdRef.current) return;
      const kind: CallKind = p.kind === "video" ? "video" : "audio";
      callIdRef.current = p.callId;
      kindRef.current = kind;
      setState({ ...IDLE, phase: "incoming", callId: p.callId, peer: p.from, conversationId: p.conversationId, kind });
      ringtone.current = playRingtone();
    };

    const onRinging = (p: { callId: string; to: UserCard; kind?: CallKind }) => {
      callIdRef.current = p.callId;
      const kind: CallKind = p.kind === "video" ? "video" : "audio";
      kindRef.current = kind;
      setState((s) => ({ ...s, phase: "outgoing", callId: p.callId, peer: p.to, kind }));
    };

    // The callee picked up: the caller is the one that makes the offer.
    const onAccepted = async (p: { callId: string }) => {
      setState((s) => ({ ...s, phase: "connecting" }));
      if (!localStream.current) {
        socket.emit("call:failure", { callId: p.callId });
        return;
      }
      const connection = await createPeer(p.callId, localStream.current);
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      socket.emit("call:signal", { callId: p.callId, data: { sdp: connection.localDescription } });
    };

    const onSignal = async (p: {
      callId: string;
      data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; camera?: boolean };
    }) => {
      // A camera announcement is not WebRTC, just a note from the peer.
      if (typeof p.data?.camera === "boolean") {
        remoteCameraOn.current = p.data.camera;
        syncRemoteVideo.current?.();
        return;
      }
      const connection = pc.current;
      if (!connection) return;
      try {
        if (p.data.sdp) {
          await connection.setRemoteDescription(new RTCSessionDescription(p.data.sdp));
          // Candidates that arrived before the description could be applied.
          for (const candidate of pendingCandidates.current.splice(0)) {
            await connection.addIceCandidate(candidate).catch(() => {});
          }
          if (p.data.sdp.type === "offer") {
            const answer = await connection.createAnswer();
            await connection.setLocalDescription(answer);
            socket.emit("call:signal", { callId: p.callId, data: { sdp: connection.localDescription } });
          }
        } else if (p.data.candidate) {
          if (connection.remoteDescription) await connection.addIceCandidate(p.data.candidate).catch(() => {});
          else pendingCandidates.current.push(p.data.candidate);
        }
      } catch {
        socket.emit("call:failure", { callId: p.callId });
      }
    };

    const onEnded = (p: { callId: string; reason: string }) => {
      if (callIdRef.current && p.callId !== callIdRef.current) return;
      reset(describeEnd(p.reason));
      // The finished call becomes an entry in the thread.
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["unread", "messages"] });
    };

    const onFailed = (p: { reason: string; message: string }) => reset(p.message);
    // Another of this account's tabs answered or declined.
    const onHandled = () => reset();

    socket.on("call:incoming", onIncoming);
    socket.on("call:ringing", onRinging);
    socket.on("call:accepted", onAccepted);
    socket.on("call:signal", onSignal);
    socket.on("call:ended", onEnded);
    socket.on("call:failed", onFailed);
    socket.on("call:handled", onHandled);
    return () => {
      socket.off("call:incoming", onIncoming);
      socket.off("call:ringing", onRinging);
      socket.off("call:accepted", onAccepted);
      socket.off("call:signal", onSignal);
      socket.off("call:ended", onEnded);
      socket.off("call:failed", onFailed);
      socket.off("call:handled", onHandled);
    };
  }, [user, createPeer, reset, queryClient]);

  /** Losing the socket loses the call: signalling can no longer reach the peer. */
  useEffect(() => {
    if (state.phase === "idle" || state.phase === "ended") return;
    const socket = getSocket();
    const onDisconnect = () => reset("The connection dropped.");
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("disconnect", onDisconnect);
    };
  }, [state.phase, reset]);

  // Keep the ref in step with the rendered phase.
  useEffect(() => {
    phaseRef.current = state.phase;
  }, [state.phase]);

  /* --------------------------------------------------------------- timer */

  useEffect(() => {
    if (state.phase !== "active") return;
    const id = window.setInterval(() => {
      setState((s) => ({ ...s, elapsedMs: answeredAt.current ? Date.now() - answeredAt.current : 0 }));
    }, 500);
    return () => window.clearInterval(id);
  }, [state.phase]);

  /** A call in progress should survive an accidental tab close only on purpose. */
  useEffect(() => {
    if (state.phase !== "active" && state.phase !== "connecting") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.phase]);

  useEffect(() => cleanupMedia, [cleanupMedia]);

  const value = useMemo<CallApi>(
    () => ({ ...state, startCall, accept, decline, hangUp, toggleMute, toggleCamera, attachVideo, dismissError }),
    [state, startCall, accept, decline, hangUp, toggleMute, toggleCamera, attachVideo, dismissError],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

/**
 * A soft two-tone ring built with the Web Audio API — no asset to ship, and it
 * respects the page's audio context lifecycle.
 */
function playRingtone(): { stop: () => void } {
  let ctx: AudioContext | null = null;
  let timer: number | undefined;
  let stopped = false;
  try {
    ctx = new AudioContext();
  } catch {
    return { stop: () => {} };
  }

  const beep = () => {
    if (!ctx || stopped) return;
    const now = ctx.currentTime;
    for (const [index, frequency] of [440, 554].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      osc.type = "sine";
      const start = now + index * 0.22;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.08, start + 0.04);
      gain.gain.linearRampToValueAtTime(0, start + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    }
  };

  beep();
  timer = window.setInterval(beep, 2400);

  return {
    stop() {
      stopped = true;
      if (timer) window.clearInterval(timer);
      void ctx?.close().catch(() => {});
      ctx = null;
    },
  };
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCall(): CallApi {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used inside CallProvider");
  return ctx;
}
