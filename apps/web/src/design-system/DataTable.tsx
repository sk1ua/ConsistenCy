import React from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  width?: string | number;
  align?: "left" | "center" | "right";
  sortable?: boolean;
  render?: (row: T, index: number) => React.ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string;
  emptyMessage?: React.ReactNode;
  sortKey?: string;
  sortDirection?: "asc" | "desc";
  onSortChange?: (key: string) => void;
  className?: string;
}

export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  selectedKey,
  emptyMessage = "暂无数据",
  sortKey,
  sortDirection,
  onSortChange,
  className = ""
}: DataTableProps<T>) {
  return (
    <div className={`ds-table-wrapper ${className}`.trim()}>
      <table className="ds-table">
        <thead>
          <tr>
            {columns.map(col => {
              const isSorted = sortKey === col.key;
              return (
                <th
                  key={col.key}
                  style={{
                    width: col.width,
                    textAlign: col.align ?? "left",
                    cursor: col.sortable ? "pointer" : "default"
                  }}
                  onClick={() => {
                    if (col.sortable && onSortChange) {
                      onSortChange(col.key);
                    }
                  }}
                >
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      justifyContent: col.align === "right" ? "flex-end" : col.align === "center" ? "center" : "flex-start"
                    }}
                  >
                    <span>{col.header}</span>
                    {col.sortable && (
                      <span style={{ color: isSorted ? "var(--primary)" : "var(--muted)", display: "inline-flex" }}>
                        {isSorted ? (
                          sortDirection === "asc" ? (
                            <ArrowUp size={12} />
                          ) : (
                            <ArrowDown size={12} />
                          )
                        ) : (
                          <ArrowUpDown size={12} />
                        )}
                      </span>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                style={{ textAlign: "center", padding: "28px", color: "var(--muted)" }}
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, index) => {
              const key = keyExtractor(row, index);
              const isSelected = selectedKey === key;
              return (
                <tr
                  key={key}
                  onClick={() => onRowClick && onRowClick(row)}
                  style={{
                    cursor: onRowClick ? "pointer" : "default",
                    background: isSelected ? "var(--surface-subtle)" : undefined
                  }}
                >
                  {columns.map(col => (
                    <td
                      key={col.key}
                      style={{
                        textAlign: col.align ?? "left"
                      }}
                    >
                      {col.render ? col.render(row, index) : (row as any)[col.key]}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
