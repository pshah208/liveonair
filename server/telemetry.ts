import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

const TRACER_NAME = "matchlens.storyline-desk";
let enabled = false;

/**
 * Starts Azure Monitor OpenTelemetry when APPLICATIONINSIGHTS_CONNECTION_STRING is set. Must run before
 * express/http are imported so auto-instrumentation can patch them. Without the variable this is a no-op and
 * the @opentelemetry/api calls below record nothing.
 */
export async function initTelemetry(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const connectionString = env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();
  if (!connectionString || enabled) {
    return enabled;
  }
  const { useAzureMonitor } = await import("@azure/monitor-opentelemetry");
  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
    instrumentationOptions: { http: { enabled: true } },
  });
  enabled = true;
  return true;
}

export function telemetryEnabled(): boolean {
  return enabled;
}

function cleanAttributes(attributes: Record<string, string | number | boolean | undefined>): Attributes {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as Attributes;
}

/** Runs `run` inside a span; the callback can add outcome/recovery attributes before it ends. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { attributes: cleanAttributes(attributes) }, async (span) => {
    try {
      const result = await run(span);
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : "error" });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Records an instantaneous span for a coordinator handoff. */
export function recordHandoffSpan(attributes: Record<string, string | number | boolean | undefined>): void {
  const span = trace.getTracer(TRACER_NAME).startSpan("desk.handoff", { attributes: cleanAttributes(attributes) });
  if (attributes.outcome === "failed") {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}
