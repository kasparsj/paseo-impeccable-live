#!/usr/bin/env node
import { createServer } from "node:http";

const [mode, portValue = "0", delayValue = "0"] = process.argv.slice(2);
const requestedPort = Number(portValue);
const delay = Number(delayValue);

if (mode === "exit") {
  process.stderr.write("fixture startup failed\n");
  process.exit(17);
}

const server = createServer((_request, response) => {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>Development fixture</title>");
});

server.on("error", (error) => {
  if (mode === "fallback" && error && error.code === "EADDRINUSE") {
    server.listen(0, "127.0.0.1");
    return;
  }
  process.stderr.write(`${error.code ?? error.message}\n`);
  process.exit(18);
});

server.on("listening", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(19);
  const message = `\u001b[32mLocal: http://0.0.0.0:${address.port}/\u001b[0m\n`;
  process.stdout.write(message.slice(0, 12));
  setTimeout(() => process.stdout.write(message.slice(12)), 15);
});

const listen = () => server.listen(requestedPort, "127.0.0.1");
if (delay > 0) setTimeout(listen, delay);
else listen();

const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
