import { createApp } from "./app.js";
import { createPlatform } from "./platform.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const platform = createPlatform(process.env);
const app = createApp({ platform });
const server = app.listen(port, "0.0.0.0", () => {
  const transport = platform.live.status();
  console.log(JSON.stringify({
    message: "Live on Air backend listening",
    port,
    liveTransport: transport.transport,
    liveTransportConfigured: transport.transportConfigured,
    desk: platform.desk.health(),
  }));
});

async function shutdown(): Promise<void> {
  server.close();
  // SSE responses keep sockets open; close them so the process can exit promptly.
  server.closeAllConnections();
  await platform.close();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
