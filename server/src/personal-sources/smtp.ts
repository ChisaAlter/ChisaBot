import nodemailer from "nodemailer";
import SMTPPool from "nodemailer/lib/smtp-pool";
import { resolvePublic } from "../../../shared/net/guarded-fetch";
import {
  DeliveryOutcomeUnknownError,
  DeliveryRejectedError,
} from "../delivery/durable-dispatch";

export type SmtpMessage = {
  host: string;
  port: number;
  from: string;
  pass: string;
  to: string;
  subject: string;
  body: string;
  id: string;
  signal?: AbortSignal;
};

export function smtpFailure(error: unknown): Error {
  const e = error as { code?: string; command?: string; responseCode?: number };
  if (
    (e.responseCode && e.responseCode >= 400) ||
    ["EAUTH", "EENVELOPE", "EDNS", "ETLS"].includes(e.code ?? "") ||
    e.command === "CONN"
  ) {
    return new DeliveryRejectedError(
      `SMTP 未接受邮件${e.responseCode ? `（响应码 ${e.responseCode}）` : ""}，请检查连接、授权码及收件人。`,
    );
  }
  return new DeliveryOutcomeUnknownError(
    "SMTP 提交后未收到完整确认，发送结果待核对；不会自动重发。",
  );
}

export async function sendSmtpMessage(input: SmtpMessage): Promise<string[]> {
  if (input.signal?.aborted) throw new DeliveryRejectedError("发送前已取消。");
  let address: { address: string; family: number };
  try {
    address = await resolvePublic(input.host);
  } catch {
    throw new DeliveryRejectedError(
      "SMTP 地址无法解析为允许连接的公网地址，未发送。",
    );
  }
  if (input.signal?.aborted) throw new DeliveryRejectedError("发送前已取消。");
  const pool = new SMTPPool({
    pool: true,
    maxConnections: 1,
    maxMessages: 1,
    maxRequeues: 0,
    host: address.address,
    port: input.port,
    secure: input.port === 465,
    requireTLS: input.port !== 465,
    auth: { user: input.from, pass: input.pass },
    tls: { servername: input.host, rejectUnauthorized: true },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 10_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const transport = nodemailer.createTransport(pool);
  const cancel = () => pool.close({ force: true });
  const deadline = setTimeout(cancel, 20_000);
  input.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await transport.sendMail({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.body,
      messageId: `<${Buffer.from(input.id).toString("base64url")}@chisabot.local>`,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!result.accepted.length)
      throw new DeliveryRejectedError("SMTP 未接受收件人，邮件未发送。");
    return result.messageId ? [result.messageId] : [];
  } catch (error) {
    if (error instanceof DeliveryRejectedError) throw error;
    throw smtpFailure(error);
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", cancel);
    pool.close({ force: true });
  }
}
