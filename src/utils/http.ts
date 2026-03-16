import { IncomingMessage } from "node:http";

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  if (!rawBody) {
    return {} as T;
  }

  return JSON.parse(rawBody) as T;
}

export function sendJson(response: {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}

export function sendText(response: {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}, statusCode: number, contentType: string, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.end(body);
}

export function redirect(response: {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}, location: string, statusCode = 302): void {
  response.statusCode = statusCode;
  response.setHeader("Location", location);
  response.end();
}