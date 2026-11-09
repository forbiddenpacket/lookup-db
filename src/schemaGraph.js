export function buildSchemaGraph(tables, relationships) {
  const names = new Set(tables.map((table) => table.name));
  const parsedRelationships = relationships.flatMap((relationship, index) => {
    const [source, sourceColumn, ...sourceExtra] = String(relationship.from ?? "").split(".");
    const [target, targetColumn, ...targetExtra] = String(relationship.to ?? "").split(".");
    if (
      !source ||
      !sourceColumn ||
      sourceExtra.length ||
      !target ||
      !targetColumn ||
      targetExtra.length
    )
      return [];
    if (!names.has(source) || !names.has(target)) return [];
    return [{ index, source, sourceColumn, target, targetColumn }];
  });

  const parent = new Map(tables.map(({ name }) => [name, name]));
  const find = (name) => {
    const root = parent.get(name);
    if (root !== name) parent.set(name, find(root));
    return parent.get(name);
  };
  for (const rel of parsedRelationships) {
    const sourceRoot = find(rel.source);
    const targetRoot = find(rel.target);
    if (sourceRoot !== targetRoot) parent.set(targetRoot, sourceRoot);
  }

  const components = new Map();
  const sourceColumns = new Map(tables.map(({ name }) => [name, new Set()]));
  const targetColumns = new Map(tables.map(({ name }) => [name, new Set()]));
  for (const rel of parsedRelationships) {
    sourceColumns.get(rel.source).add(rel.sourceColumn);
    targetColumns.get(rel.target).add(rel.targetColumn);
  }
  for (const { name } of tables) {
    const root = find(name);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(name);
  }
  const colors = new Map();
  for (const [root, members] of components) {
    const hasSelfReference = parsedRelationships.some(
      (rel) => rel.source === rel.target && find(rel.source) === root,
    );
    if (members.length < 2 && !hasSelfReference) continue;
    const seed = members.slice().sort().join("|");
    let hash = 2166136261;
    for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const hue = (hash >>> 0) % 360;
    const color = `hsl(${hue} 62% 62%)`;
    for (const name of members) colors.set(name, color);
  }

  const edges = parsedRelationships.map(({ index, source, sourceColumn, target, targetColumn }) => {
    const color = colors.get(source) ?? "#71717a";
    return {
      id: `fk-${index}-${source}-${sourceColumn}-${target}-${targetColumn}`,
      source,
      sourceHandle: `${source}.${sourceColumn}.source`,
      target,
      targetHandle: `${target}.${targetColumn}.target`,
      label: `${sourceColumn} → ${targetColumn}`,
      type: "smoothstep",
      animated: false,
      style: { stroke: color, strokeWidth: 1.75 },
      labelStyle: { fill: color, fontSize: 11 },
      labelBgStyle: { fill: "#18181b" },
    };
  });
  const colCount = Math.min(3, Math.max(1, tables.length));
  const colY = new Array(colCount).fill(24);
  const nodes = tables.map((table, index) => {
    const col = index % colCount;
    const y = colY[col];
    colY[col] += 54 + table.columns.length * 36;
    return {
      id: table.name,
      type: "databaseSchemaNode",
      position: { x: col * 400 + 24, y },
      data: {
        table,
        accentColor: colors.get(table.name) ?? "#71717a",
        sourceColumns: [...sourceColumns.get(table.name)],
        targetColumns: [...targetColumns.get(table.name)],
      },
    };
  });
  return { nodes, edges };
}
