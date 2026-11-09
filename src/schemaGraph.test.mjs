import test from "node:test";
import assert from "node:assert/strict";
import { buildSchemaGraph } from "./schemaGraph.js";

test("FK edges attach to the exact source and target column handles", () => {
  const graph = buildSchemaGraph(
    [
      { name: "orders", columns: [{ name: "customer_id" }] },
      { name: "customers", columns: [{ name: "id" }] },
    ],
    [{ from: "orders.customer_id", to: "customers.id" }],
  );

  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].source, "orders");
  assert.equal(graph.edges[0].sourceHandle, "orders.customer_id.source");
  assert.equal(graph.edges[0].target, "customers");
  assert.equal(graph.edges[0].targetHandle, "customers.id.target");
});

test("ignores malformed or missing-table relationships", () => {
  const graph = buildSchemaGraph(
    [{ name: "orders", columns: [{ name: "customer_id" }] }],
    [
      { from: "orders.customer_id", to: "missing.id" },
      { from: "bad", to: "orders.customer_id" },
    ],
  );

  assert.equal(graph.edges.length, 0);
});

test("tables in one FK-connected component share one stable accent; isolated tables are neutral", () => {
  const tables = [
    { name: "orders", columns: [{ name: "customer_id" }] },
    { name: "customers", columns: [{ name: "id" }] },
    { name: "audit_log", columns: [{ name: "id" }] },
  ];
  const relationships = [{ from: "orders.customer_id", to: "customers.id" }];
  const first = buildSchemaGraph(tables, relationships);
  const second = buildSchemaGraph(tables, relationships);

  assert.equal(first.nodes[0].data.accentColor, first.nodes[1].data.accentColor);
  assert.match(first.nodes[0].data.accentColor, /^hsl\(/);
  assert.equal(first.nodes[2].data.accentColor, "#71717a");
  assert.equal(first.nodes[0].data.accentColor, second.nodes[0].data.accentColor);
  assert.deepEqual(first.nodes[0].data.sourceColumns, ["customer_id"]);
  assert.deepEqual(first.nodes[1].data.targetColumns, ["id"]);
  assert.deepEqual(first.nodes[2].data.sourceColumns, []);
});
