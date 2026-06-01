import { jsonSchemas } from "@consistency/schema";

export function App() {
  return (
    <main>
      <h1>ConsistenCy</h1>
      <p>TypeScript product shell scaffold around the Python analysis engine.</p>
      <dl>
        <dt>API</dt>
        <dd>Node/TypeScript shell with a health endpoint.</dd>
        <dt>Schema</dt>
        <dd>{jsonSchemas.prReport.title}</dd>
        <dt>Engine</dt>
        <dd>Python parser, agents, scoring, evaluation, and model artifacts.</dd>
      </dl>
    </main>
  );
}
