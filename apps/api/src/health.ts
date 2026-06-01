export type HealthPayload = {
  ok: true;
  service: "consistency-api";
  engine: "python";
  schemaVersion: "0.1.0";
};

export function buildHealthPayload(): HealthPayload {
  return {
    ok: true,
    service: "consistency-api",
    engine: "python",
    schemaVersion: "0.1.0"
  };
}
