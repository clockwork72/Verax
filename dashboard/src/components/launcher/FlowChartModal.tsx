import { useMemo } from 'react'
import ReactFlow, { Background, BackgroundVariant, Controls, Node, Edge, NodeProps, MarkerType, Handle, Position } from 'reactflow'

type FlowChartModalProps = {
  open: boolean
  onClose: () => void
  topN: string
  onTopNChange: (value: string) => void
  useCrux?: boolean
  onToggleCrux?: (next: boolean) => void
  cruxApiKey?: string
  onCruxKeyChange?: (value: string) => void
  mappingMode?: 'radar' | 'trackerdb' | 'mixed'
  onMappingModeChange?: (mode: 'radar' | 'trackerdb' | 'mixed') => void
  excludeSameEntity?: boolean
  onToggleExcludeSameEntity?: (next: boolean) => void
  onStart: () => void
  running: boolean
}

type NodeData = {
  title: string
  subtitle?: string
  width?: number
  topN?: string
  onTopNChange?: (value: string) => void
  useCrux?: boolean
  onToggleCrux?: (next: boolean) => void
  cruxApiKey?: string
  onCruxKeyChange?: (value: string) => void
  mappingMode?: 'radar' | 'trackerdb' | 'mixed'
  onMappingModeChange?: (mode: 'radar' | 'trackerdb' | 'mixed') => void
  excludeSameEntity?: boolean
  onToggleExcludeSameEntity?: (next: boolean) => void
  onStart?: () => void
  running?: boolean
}

function NodeShell({
  title,
  subtitle,
  children,
  width = 220,
  source = false,
  target = false,
}: {
  title: string
  subtitle?: string
  children?: React.ReactNode
  width?: number
  source?: boolean
  target?: boolean
}) {
  return (
    <div
      className="flow-node rounded-2xl border border-[var(--border-soft)] bg-[var(--color-surface)] px-4 py-4 text-xs text-[var(--color-text)] shadow"
      style={{ width }}
    >
      {target && <Handle type="target" position={Position.Left} className="flow-handle" />}
      {source && <Handle type="source" position={Position.Right} className="flow-handle" />}
      <div className="flow-node__title text-[10px] uppercase tracking-[0.28em] text-[var(--muted-text)]">
        {title}
      </div>
      {subtitle && <div className="flow-node__subtitle mt-2 text-[11px] text-[var(--muted-text)]">{subtitle}</div>}
      {children && <div className="mt-3 space-y-2">{children}</div>}
    </div>
  )
}

function InputNode({ data }: NodeProps<NodeData>) {
  return (
    <NodeShell title="Input" subtitle="Number of sites to scrape" width={220} source>
      <input
        type="number"
        min={1}
        value={data.topN || ''}
        onChange={(event) => data.onTopNChange?.(event.target.value)}
        className="focusable w-full rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-xs text-white"
        placeholder="1000"
      />
    </NodeShell>
  )
}

function CruxNode({ data }: NodeProps<NodeData>) {
  return (
    <NodeShell title="CrUX Filter" subtitle="Keep browsable origins only" width={240} source target>
      <button
        className={`focusable rounded-full border px-3 py-1 text-xs ${
          data.useCrux ? 'border-[var(--color-danger)] text-white' : 'border-[var(--border-soft)] text-[var(--muted-text)]'
        }`}
        onClick={() => data.onToggleCrux?.(!data.useCrux)}
      >
        CrUX {data.useCrux ? 'on' : 'off'}
      </button>
      {data.useCrux && (
        <input
          type="password"
          className="focusable w-full rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-xs text-white"
          placeholder="CrUX API key"
          value={data.cruxApiKey || ''}
          onChange={(event) => data.onCruxKeyChange?.(event.target.value)}
        />
      )}
    </NodeShell>
  )
}

function MappingNode({ data }: NodeProps<NodeData>) {
  const options = [
    { id: 'radar', label: 'Tracker Radar' },
    { id: 'trackerdb', label: 'TrackerDB' },
    { id: 'mixed', label: 'Mixed' },
  ] as const
  return (
    <NodeShell title="Mapping" subtitle="Choose entity resolution" width={260} source target>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt.id}
            className={`focusable rounded-full border px-3 py-1 text-xs ${
              data.mappingMode === opt.id
                ? 'border-[var(--color-danger)] text-white'
                : 'border-[var(--border-soft)] text-[var(--muted-text)]'
            }`}
            onClick={() => data.onMappingModeChange?.(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-[var(--muted-text)]">Mixed = Radar first, TrackerDB fallback.</p>
    </NodeShell>
  )
}

function ExcludeNode({ data }: NodeProps<NodeData>) {
  return (
    <NodeShell title="Filter" subtitle="Exclude same-entity services" width={240} source target>
      <button
        className={`focusable rounded-full border px-3 py-1 text-xs ${
          data.excludeSameEntity
            ? 'border-[var(--color-danger)] text-white'
            : 'border-[var(--border-soft)] text-[var(--muted-text)]'
        }`}
        onClick={() => data.onToggleExcludeSameEntity?.(!data.excludeSameEntity)}
      >
        Exclude same‑entity {data.excludeSameEntity ? 'on' : 'off'}
      </button>
    </NodeShell>
  )
}

function InfoNode({ data }: NodeProps<NodeData>) {
  return <NodeShell title={data.title} subtitle={data.subtitle} width={240} source target />
}

function OutputNode(_: NodeProps<NodeData>) {
  return (
    <NodeShell title="Outputs" subtitle="Artifacts per run" width={240} target>
      <div className="text-[11px] text-[var(--muted-text)]">results.jsonl</div>
      <div className="text-[11px] text-[var(--muted-text)]">results.summary.json</div>
      <div className="text-[11px] text-[var(--muted-text)]">run_state.json</div>
      <div className="text-[11px] text-[var(--muted-text)]">explorer.jsonl</div>
    </NodeShell>
  )
}

function ActionNode({ data }: NodeProps<NodeData>) {
  return (
    <NodeShell title="Launch" subtitle="Start the crawl" width={220} source>
      <button
        className="focusable w-full rounded-full bg-[var(--color-primary)] px-4 py-2 text-xs font-semibold text-white"
        onClick={data.onStart}
        disabled={data.running}
      >
        {data.running ? 'Running…' : 'Start run'}
      </button>
    </NodeShell>
  )
}

export function FlowChartModal({
  open,
  onClose,
  topN,
  onTopNChange,
  useCrux,
  onToggleCrux,
  cruxApiKey,
  onCruxKeyChange,
  mappingMode,
  onMappingModeChange,
  excludeSameEntity,
  onToggleExcludeSameEntity,
  onStart,
  running,
}: FlowChartModalProps) {
  const nodes = useMemo<Node<NodeData>[]>(
    () => [
      {
        id: 'input',
        type: 'inputNode',
        position: { x: 40, y: 40 },
        data: { title: 'Input', topN, onTopNChange },
      },
      {
        id: 'crux',
        type: 'cruxNode',
        position: { x: 300, y: 40 },
        data: { title: 'CrUX', useCrux, onToggleCrux, cruxApiKey, onCruxKeyChange },
      },
      {
        id: 'mapping',
        type: 'mappingNode',
        position: { x: 580, y: 40 },
        data: { title: 'Mapping', mappingMode, onMappingModeChange },
      },
      {
        id: 'exclude',
        type: 'excludeNode',
        position: { x: 860, y: 40 },
        data: { title: 'Filter', excludeSameEntity, onToggleExcludeSameEntity },
      },
      {
        id: 'crawl',
        type: 'infoNode',
        position: { x: 40, y: 220 },
        data: { title: 'Crawl4AI fetch', subtitle: 'Homepage rendering + network capture' },
      },
      {
        id: 'policy',
        type: 'infoNode',
        position: { x: 300, y: 220 },
        data: { title: 'Policy discovery', subtitle: 'Score links + fetch best policy page' },
      },
      {
        id: 'thirdparty',
        type: 'infoNode',
        position: { x: 580, y: 220 },
        data: { title: '3P extraction', subtitle: 'Derive third-party eTLD+1 from requests' },
      },
      {
        id: 'mapfetch',
        type: 'infoNode',
        position: { x: 860, y: 220 },
        data: { title: 'Map + policy fetch', subtitle: 'Entity/category mapping + optional policy text' },
      },
      {
        id: 'outputs',
        type: 'outputNode',
        position: { x: 580, y: 420 },
        data: { title: 'Outputs' },
      },
      {
        id: 'launch',
        type: 'actionNode',
        position: { x: 40, y: 420 },
        data: { title: 'Launch', onStart, running },
      },
    ],
    [
      topN,
      onTopNChange,
      useCrux,
      onToggleCrux,
      cruxApiKey,
      onCruxKeyChange,
      mappingMode,
      onMappingModeChange,
      excludeSameEntity,
      onToggleExcludeSameEntity,
      onStart,
      running,
    ],
  )

  const edges = useMemo<Edge[]>(
    () => [
      { id: 'e1', source: 'input', target: 'crux', type: 'smoothstep', animated: true, markerEnd: { type: MarkerType.ArrowClosed } },
      { id: 'e2', source: 'crux', target: 'mapping', type: 'smoothstep', animated: true, markerEnd: { type: MarkerType.ArrowClosed } },
      { id: 'e3', source: 'mapping', target: 'exclude', type: 'smoothstep', animated: true, markerEnd: { type: MarkerType.ArrowClosed } },
      { id: 'e4', source: 'exclude', target: 'crawl', type: 'smoothstep', animated: true, markerEnd: { type: MarkerType.ArrowClosed } },
      { id: 'e5', source: 'crawl', target: 'policy', type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } },
      { id: 'e6', source: 'policy', target: 'thirdparty', type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } },
      { id: 'e7', source: 'thirdparty', target: 'mapfetch', type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } },
      { id: 'e8', source: 'mapfetch', target: 'outputs', type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } },
      { id: 'e9', source: 'launch', target: 'crawl', type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } },
    ],
    [],
  )

  if (!open) return null

  return (
    <div className="flow-modal fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="card flow-panel w-full max-w-6xl rounded-3xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Flow chart</p>
            <h3 className="text-lg font-semibold">Scraper architecture</h3>
          </div>
          <button
            className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="flow-canvas mt-4 h-[560px] overflow-hidden rounded-2xl border border-[var(--border-soft)]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            panOnScroll
            nodesDraggable={false}
            nodesConnectable={false}
            nodeTypes={{
              inputNode: InputNode,
              cruxNode: CruxNode,
              mappingNode: MappingNode,
              excludeNode: ExcludeNode,
              infoNode: InfoNode,
              outputNode: OutputNode,
              actionNode: ActionNode,
            }}
          >
            <Controls />
            <Background variant={BackgroundVariant.Lines} gap={22} size={1} color="var(--border-soft)" />
          </ReactFlow>
        </div>
      </div>
    </div>
  )
}
