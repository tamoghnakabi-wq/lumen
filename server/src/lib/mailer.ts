import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.ts";
import { log } from "./log.ts";

let transport: Transporter | null = null;
let ready = false;

function getTransport(): Transporter | null {
  if (ready) return transport;
  ready = true;
  if (!config.smtp.url) return null;
  try {
    transport = nodemailer.createTransport(config.smtp.url);
    log.info("mail transport configured");
  } catch (err) {
    log.error("mail transport could not be created", {
      message: err instanceof Error ? err.message : String(err),
    });
    transport = null;
  }
  return transport;
}

export function mailEnabled(): boolean {
  return getTransport() !== null;
}

/** Verifies the SMTP connection at boot so a misconfiguration surfaces immediately. */
export async function verifyMailTransport(): Promise<boolean> {
  const t = getTransport();
  if (!t) return false;
  try {
    await t.verify();
    log.info("mail transport verified");
    return true;
  } catch (err) {
    log.error("mail transport failed verification", {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Sends the password reset link. When no transport is configured the link is
 * written to the server log only — never to the HTTP response, so the endpoint
 * cannot be used to take over an account you do not control.
 */
export async function sendPasswordReset(to: string, link: string): Promise<"sent" | "logged" | "failed"> {
  const t = getTransport();
  if (!t) {
    log.warn("password reset link (no mail transport configured)", { to, link });
    return "logged";
  }
  try {
    await t.sendMail({
      from: config.smtp.from,
      to,
      subject: "Reset your Lumen password",
      text: [
        "Someone asked to reset the password for your Lumen account.",
        "",
        `Open this link to choose a new one: ${link}`,
        "",
        `The link works once and expires in ${Math.round(config.resetTtlMs / 60000)} minutes.`,
        "If this wasn't you, you can ignore this email — nothing has changed.",
      ].join("\n"),
      html: `
        <p>Someone asked to reset the password for your Lumen account.</p>
        <p><a href="${escapeHtml(link)}">Choose a new password</a></p>
        <p>The link works once and expires in ${Math.round(config.resetTtlMs / 60000)} minutes.
        If this wasn't you, you can ignore this email — nothing has changed.</p>`,
    });
    log.info("password reset email sent", { to });
    return "sent";
  } catch (err) {
    log.error("password reset email failed", { to, message: err instanceof Error ? err.message : String(err) });
    return "failed";
  }
}
