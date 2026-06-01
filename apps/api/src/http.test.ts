import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "./http";
import type { RunProcess } from "./pythonBridge";

const validAnalysisResult = {
  risk_score: 0.1,
  raw_score: 0.1,
  risk_level: "Minor Drift",
  risk_colour: "YELLOW",
  breakdown: { semantic: 0.1 },
  signal_results: {
    semantic: {
      signal_name: "semantic",
      score: 0.1,
      evidence: [],
      confidence: 1,
      metadata: {}
    }
  },
  signal_composition: { semantic: 1 },
  dominant_signals: ["semantic"],
  confidence: 0.8,
  explainability: {
    dominant_signals: ["semantic"],
    contributions: { semantic: 1 },
    evidence_chain: [{ signal_name: "semantic", text: "changed" }],
    confidence: 0.8
  },
  agent_collaboration: {
    scope: "file.py",
    decision: "monitor",
    consensus_score: 0.1,
    confidence: 0.8,
    quorum: "5/5",
    participants: ["SemanticAgent"],
    protocol: "parallel_agents -> evidence_normalization -> weighted_consensus -> reviewer_handoff"
  },
  evidence: [],
  agent_details: {
    SemanticAgent: {
      score: 0.1,
      evidence: [],
      elapsed_ms: 1
    }
  }
};

function postJson(port: number, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw)
        }
      },
      res => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", chunk => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(responseBody) });
        });
      }
    );
    req.on("error", reject);
    req.end(raw);
  });
}

describe("createApiServer", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        server =>
          new Promise<void>(resolve => {
            server.close(() => resolve());
          })
      )
    );
    servers.length = 0;
  });

  it("serves POST /analyze-file through the Python bridge", async () => {
    const runProcess: RunProcess = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(validAnalysisResult),
      stderr: ""
    });
    const server = createApiServer({ runProcess });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP port");
    }

    const response = await postJson(address.port, "/analyze-file", {
      currentFile: "examples/demo_new.py",
      baselineFile: "examples/demo_base.py"
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ risk_score: 0.1 });
  });
});
