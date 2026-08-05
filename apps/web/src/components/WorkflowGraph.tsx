import { useMemo } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type Connection, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { motion } from "framer-motion";
import type { WorkflowSpec } from "@consistency/schema";

type StepRole = "node" | "verifier" | "synthesizer";

type AnyStep = WorkflowSpec["nodes"][number] | WorkflowSpec["verifiers"][number] | WorkflowSpec["synthesizer"];

type WorkflowNodeData = { step: AnyStep; role: StepRole };
type WorkflowFlowNode = Node<WorkflowNodeData>;

function WorkflowNodeView({ data, selected }: NodeProps<WorkflowFlowNode>) {
  return (
    <motion.div
      className={`workflow-node workflow-node-${data.role}${selected ? " selected" : ""}`}
      animate={{ scale: selected ? 1.04 : 1 }}
      transition={{ duration: 0.18 }}
    >
      <Handle type="target" position={Position.Top} />
      <span className="workflow-node-role">{data.role}</span>
      <strong>{data.step.id}</strong>
      <code>{data.step.uses}</code>
      <Handle type="source" position={Position.Bottom} />
    </motion.div>
  );
}

const nodeTypes = { workflow: WorkflowNodeView };

function stepsOf(spec: WorkflowSpec): { step: AnyStep; role: StepRole }[] {
  return [
    ...spec.nodes.map(step => ({ step, role: "node" as const })),
    ...spec.verifiers.map(step => ({ step, role: "verifier" as const })),
    { step: spec.synthesizer, role: "synthesizer" as const }
  ];
}

export function layoutWorkflow(spec: WorkflowSpec): { nodes: WorkflowFlowNode[]; edges: Edge[] } {
  const steps = stepsOf(spec);
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 64 });
  for (const { step } of steps) {
    graph.setNode(step.id, { width: 190, height: 64 });
  }
  for (const { step } of steps) {
    for (const need of step.needs) {
      graph.setEdge(need, step.id);
    }
  }
  dagre.layout(graph);

  const nodes: WorkflowFlowNode[] = steps.map(({ step, role }) => {
    const point = graph.node(step.id);
    return {
      id: step.id,
      type: "workflow",
      position: { x: point.x - 95, y: point.y - 32 },
      data: { step, role }
    };
  });
  const edges: Edge[] = steps.flatMap(({ step }) =>
    step.needs
      .filter(need => steps.some(item => item.step.id === need))
      .map(need => ({ id: `${need}->${step.id}`, source: need, target: step.id, animated: false }))
  );
  return { nodes, edges };
}

export function WorkflowGraph({ spec, selectedId, onSelect, onConnectSteps }: {
  spec: WorkflowSpec;
  selectedId?: string;
  onSelect?: (id: string) => void;
  onConnectSteps?: (source: string, target: string) => void;
}) {
  const { nodes, edges } = useMemo(() => layoutWorkflow(spec), [spec]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      nodesConnectable={Boolean(onConnectSteps)}
      onNodeClick={(_event, node) => onSelect?.(node.id)}
      onConnect={(connection: Connection) => {
        if (connection.source && connection.target && connection.source !== connection.target) {
          onConnectSteps?.(connection.source, connection.target);
        }
      }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={18} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
