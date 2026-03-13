import { useMemo } from 'react'

import type { ResultRecord, RunSummary } from '../../contracts/api'
import type { ExplorerSite } from '../../data/explorer'
import {
  resolveCategoryServiceHeatmap,
  type CategoryServiceHeatmap as CategoryServiceHeatmapData,
} from '../../utils/categoryServiceHeatmap'
import { BentoCard } from '../ui/BentoCard'

type CategoryServiceHeatmapProps = {
  summary?: RunSummary | null
  records?: ResultRecord[] | null
  sites?: ExplorerSite[] | null
}

const FIGURE_FONT = {
  fontFamily: '"Times New Roman", "Nimbus Roman No9 L", "Liberation Serif", serif',
}

function cellStyle(cell: CategoryServiceHeatmapData['rows'][number]['cells'][number]) {
  if (cell.totalSites <= 0) {
    return {
      backgroundColor: '#f2f2f0',
      backgroundImage:
        'repeating-linear-gradient(45deg, rgba(58,58,58,0.12) 0 2px, transparent 2px 8px), repeating-linear-gradient(-45deg, rgba(58,58,58,0.08) 0 2px, transparent 2px 8px)',
      color: '#555555',
    }
  }

  if (cell.zeroOverlap) {
    return {
      backgroundColor: '#fcfcfb',
      backgroundImage: 'repeating-linear-gradient(135deg, rgba(42,42,42,0.16) 0 2px, transparent 2px 8px)',
      color: '#4a4a4a',
    }
  }

  const ratio = Math.max(0, Math.min(1, cell.percentage / 100))
  const alpha = 0.15 + Math.sqrt(ratio) * 0.78
  return {
    backgroundColor: `rgba(20, 76, 138, ${alpha.toFixed(3)})`,
    color: ratio >= 0.48 ? '#ffffff' : '#0f2238',
  }
}

function formatPercent(value: number) {
  if (value >= 10) return `${Math.round(value)}%`
  if (value > 0) return `${value.toFixed(1)}%`
  return '0%'
}

function serviceLabelParts(label: string): string[] {
  if (label.includes(' & ')) return label.split(' & ')
  if (label.includes(' ')) {
    const words = label.split(' ')
    const midpoint = Math.ceil(words.length / 2)
    return [words.slice(0, midpoint).join(' '), words.slice(midpoint).join(' ')].filter(Boolean)
  }
  return [label]
}

export function CategoryServiceHeatmap({ summary, records, sites }: CategoryServiceHeatmapProps) {
  const heatmap = useMemo(
    () => resolveCategoryServiceHeatmap({
      summaryHeatmap: summary?.category_service_heatmap,
      records,
      sites,
    }),
    [records, sites, summary?.category_service_heatmap],
  )

  return (
    <BentoCard>
      <div className="mb-4">
        <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Category relationships</p>
        <h3 className="mt-1 text-sm font-semibold">Website category × third-party service category</h3>
        <p className="mt-1 text-[12px] text-[var(--muted-text)]">
          Cell values show the share of sites in each website category that invoke at least one third-party service in the column category.
        </p>
      </div>

      {!heatmap && (
        <p className="text-[12px] text-[var(--muted-text)]">No category-service overlap data is available yet.</p>
      )}

      {heatmap && (
        <div className="overflow-x-auto">
          <div
            className="mx-auto w-fit min-w-[42rem] rounded-[18px] border border-[rgba(15,23,42,0.16)] bg-[#fffdf8] px-4 py-4 text-[#161616] shadow-[0_14px_34px_rgba(15,23,42,0.08)]"
            style={FIGURE_FONT}
          >
            <div className="mb-3 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-[12px] font-semibold tracking-[0.04em] text-[#232323]">Grouped heatmap</p>
                <p className="mt-1 text-[11px] text-[#555555]">Rows: website categories. Columns: third-party service categories.</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[10px] text-[#505050]">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-[2px] border border-[rgba(0,0,0,0.16)] bg-[#fcfcfb]" style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(42,42,42,0.16) 0 2px, transparent 2px 8px)' }} />
                  <span>Zero</span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-20 rounded-[2px] border border-[rgba(0,0,0,0.12)]"
                    style={{ background: 'linear-gradient(90deg, rgba(20, 76, 138, 0.12) 0%, rgba(20, 76, 138, 0.92) 100%)' }}
                  />
                  <span>0–100%</span>
                </div>
              </div>
            </div>

            <div className="mb-1.5 flex items-end gap-2">
              <div className="w-[144px] text-[11px] font-semibold text-[#2e2e2e]">Website category</div>
              <div className="flex-1 border-b border-[#1c1c1c] pb-1 text-center text-[11px] font-semibold tracking-[0.03em] text-[#2e2e2e]">
                Third-party service category
              </div>
            </div>

            <div
              className="grid items-center gap-x-1.5 gap-y-1.5"
              style={{ gridTemplateColumns: '144px repeat(9, 48px)' }}
            >
              <div />
              {heatmap.serviceCategories.map((serviceCategory) => (
                <div
                  key={serviceCategory}
                  className="flex min-h-[50px] items-end justify-center px-0.5 pb-1 text-center text-[9px] leading-[1.05] text-[#353535]"
                  title={serviceCategory}
                >
                  <div>
                    {serviceLabelParts(serviceCategory).map((part, index) => (
                      <div key={`${serviceCategory}-${index}`}>{part}</div>
                    ))}
                  </div>
                </div>
              ))}

              {heatmap.rows.map((row) => (
                <Row key={row.websiteCategory} row={row} />
              ))}
            </div>
          </div>
        </div>
      )}
    </BentoCard>
  )
}

function Row({ row }: { row: CategoryServiceHeatmapData['rows'][number] }) {
  return (
    <>
      <div className="pr-2 text-[10px] leading-[1.1] text-[#242424]">
        <div className="font-medium">{row.websiteCategory}</div>
        <div className="mt-0.5 text-[9px] text-[#666666]">n = {row.totalSites}</div>
      </div>
      {row.cells.map((cell) => {
        const style = cellStyle(cell)
        return (
          <div
            key={`${row.websiteCategory}-${cell.serviceCategory}`}
            className="flex h-[34px] w-[48px] items-center justify-center rounded-[3px] px-0.5 text-[9px] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)]"
            style={style}
            title={cell.totalSites > 0
              ? `${row.websiteCategory} × ${cell.serviceCategory}: ${formatPercent(cell.percentage)} (${cell.matchedSites}/${cell.totalSites} sites)`
              : `${row.websiteCategory} × ${cell.serviceCategory}: no sites in this website category yet`
            }
          >
            {cell.totalSites <= 0 ? '—' : formatPercent(cell.percentage)}
          </div>
        )
      })}
    </>
  )
}
