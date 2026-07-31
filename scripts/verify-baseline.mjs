import { assertNodeBaseline, assertPythonBaseline, queryPythonVersion } from "./baseline-runtime.mjs";

assertNodeBaseline(process.version);

const python = process.env.CONSISTENCY_PYTHON_PATH ?? "python";
const pythonVersion = queryPythonVersion(python);

assertPythonBaseline(pythonVersion);

console.log(`Baseline runtime verified: Node ${process.version}, Python ${pythonVersion}`);
