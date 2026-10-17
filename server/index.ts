// Telemetry must initialise before express/http are imported so Azure Monitor can instrument them,
// so the server itself is loaded dynamically after initTelemetry (a no-op without a connection string).
import { initTelemetry } from "./telemetry.js";

await initTelemetry();
await import("./main.js");