"use client";

import { useEffect, useState } from "react";
import {
  Store,
  CalendarDays,
  Tag,
  Wallet,
  PencilLine,
  CheckCircle2,
  ReceiptText,
  Package,
} from "lucide-react";

type LineItem = {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total: number;
};

export type ReceiptData = {
  vendor: { name: string | null };
  receipt: { date: string | null };
  total: number;
  currency: string | null;
  line_items: LineItem[];
  category_suggestion: string;
  billable_suggestion: boolean;
};

export default function ReceiptReview({
  receipt,
  onConfirm,
}: {
  receipt: ReceiptData;
  onConfirm: (data: ReceiptData) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);

  const [vendor, setVendor] = useState(receipt.vendor?.name || "");
  const [date, setDate] = useState(receipt.receipt?.date || "");
  const [category, setCategory] = useState(receipt.category_suggestion || "");
  const [total, setTotal] = useState<number>(receipt.total || 0);

  useEffect(() => {
    setVendor(receipt.vendor?.name || "");
    setDate(receipt.receipt?.date || "");
    setCategory(receipt.category_suggestion || "");
    setTotal(receipt.total || 0);
    setEditing(false);
  }, [receipt]);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm({
        ...receipt,
        vendor: { name: vendor || null },
        receipt: { date: date || null },
        total,
        category_suggestion: category,
      });
      setEditing(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        marginTop: "16px",
        border: "1px solid #e5e7eb",
        borderRadius: "24px",
        background:
          "linear-gradient(180deg, rgba(255,255,255,1) 0%, rgba(248,250,252,1) 100%)",
        boxShadow: "0 18px 40px rgba(15, 23, 42, 0.08)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "20px 22px",
          borderBottom: "1px solid #eef2f7",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
          <div
            style={{
              width: "52px",
              height: "52px",
              borderRadius: "16px",
              background:
                "linear-gradient(135deg, rgba(37,99,235,0.12), rgba(59,130,246,0.2))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#2563eb",
            }}
          >
            <ReceiptText size={24} />
          </div>

          <div>
            <h3
              style={{
                margin: 0,
                fontSize: "20px",
                fontWeight: 700,
                color: "#0f172a",
              }}
            >
              Receipt Review
            </h3>
            <p
              style={{
                margin: "6px 0 0",
                fontSize: "14px",
                color: "#64748b",
              }}
            >
              Review, edit, then save this expense
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setEditing((prev) => !prev)}
          style={{
            border: "1px solid #dbeafe",
            background: editing ? "#eff6ff" : "#ffffff",
            color: "#2563eb",
            borderRadius: "999px",
            padding: "10px 14px",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            whiteSpace: "nowrap",
          }}
        >
          <PencilLine size={15} />
          {editing ? "Cancel editing" : "Edit details"}
        </button>
      </div>

      <div style={{ padding: "22px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "14px",
            marginBottom: "18px",
          }}
        >
          <InfoCard
            icon={<Store size={16} />}
            label="Vendor"
            editing={editing}
            input={
              <input
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                style={inputStyle}
              />
            }
            value={vendor || "Unknown"}
          />

          <InfoCard
            icon={<CalendarDays size={16} />}
            label="Date"
            editing={editing}
            input={
              <input
                type="date"
                value={date || ""}
                onChange={(e) => setDate(e.target.value)}
                style={inputStyle}
              />
            }
            value={date || "Unknown"}
          />

          <InfoCard
            icon={<Tag size={16} />}
            label="Category"
            editing={editing}
            input={
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                style={inputStyle}
              />
            }
            value={
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "6px 12px",
                  borderRadius: "999px",
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  fontSize: "13px",
                  fontWeight: 600,
                }}
              >
                {category || "Uncategorized"}
              </span>
            }
          />

          <InfoCard
            icon={<Wallet size={16} />}
            label="Total"
            editing={editing}
            input={
              <input
                type="number"
                step="0.01"
                value={total}
                onChange={(e) => setTotal(Number(e.target.value))}
                style={inputStyle}
              />
            }
            value={
              <span
                style={{
                  fontSize: "22px",
                  fontWeight: 700,
                  color: "#0f172a",
                }}
              >
                {total} {receipt.currency || ""}
              </span>
            }
          />
        </div>

        <div
          style={{
            border: "1px solid #e9eef5",
            borderRadius: "20px",
            overflow: "hidden",
            background: "#fff",
          }}
        >
          <div
            style={{
              padding: "16px 18px",
              borderBottom: "1px solid #eef2f7",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "12px",
                  background: "#f8fafc",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#334155",
                }}
              >
                <Package size={17} />
              </div>
              <div>
                <div
                  style={{
                    fontSize: "15px",
                    fontWeight: 700,
                    color: "#0f172a",
                  }}
                >
                  Items
                </div>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#64748b",
                  }}
                >
                  {receipt.line_items?.length ?? 0} extracted line items
                </div>
              </div>
            </div>

            <span
              style={{
                padding: "7px 12px",
                borderRadius: "999px",
                background: "#f8fafc",
                fontSize: "12px",
                color: "#475569",
                fontWeight: 600,
              }}
            >
              {receipt.billable_suggestion ? "Billable" : "Non-billable"}
            </span>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "14px",
              }}
            >
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  <th style={thStyle}>Item</th>
                  <th style={thStyle}>Qty</th>
                  <th style={thStyle}>Unit Price</th>
                  <th style={thStyle}>Total</th>
                </tr>
              </thead>
              <tbody>
                {receipt.line_items?.map((item, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={tdMainStyle}>{item.description}</td>
                    <td style={tdStyle}>{item.quantity ?? "-"}</td>
                    <td style={tdStyle}>{item.unit_price ?? "-"}</td>
                    <td
                      style={{
                        ...tdStyle,
                        fontWeight: 700,
                        color: "#0f172a",
                      }}
                    >
                      {item.total}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div
          style={{
            marginTop: "18px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              fontSize: "13px",
              color: "#64748b",
            }}
          >
            Double-check extracted fields before saving to expenses.
          </div>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setEditing(true)}
              style={{
                border: "1px solid #dbe2ea",
                background: "#fff",
                color: "#334155",
                borderRadius: "14px",
                padding: "11px 16px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Edit
            </button>

            <button
              type="button"
              onClick={handleConfirm}
              disabled={loading}
              style={{
                border: "none",
                background: loading
                  ? "#94a3b8"
                  : "linear-gradient(135deg, #2563eb, #3b82f6)",
                color: "#fff",
                borderRadius: "14px",
                padding: "11px 18px",
                fontWeight: 700,
                cursor: loading ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                boxShadow: loading
                  ? "none"
                  : "0 12px 24px rgba(37, 99, 235, 0.22)",
              }}
            >
              <CheckCircle2 size={17} />
              {loading ? "Saving..." : "Add Expense"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoCard({
  icon,
  label,
  editing,
  input,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  editing: boolean;
  input: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid #e9eef5",
        borderRadius: "18px",
        background: "#ffffff",
        padding: "14px 15px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "10px",
          color: "#64748b",
          fontSize: "13px",
          fontWeight: 600,
        }}
      >
        {icon}
        <span>{label}</span>
      </div>

      <div style={{ color: "#0f172a", minHeight: "28px" }}>
        {editing ? input : value}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid #dbe2ea",
  borderRadius: "12px",
  padding: "10px 12px",
  fontSize: "14px",
  outline: "none",
  background: "#fff",
  color: "#0f172a",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 16px",
  fontSize: "12px",
  fontWeight: 700,
  color: "#64748b",
  letterSpacing: "0.02em",
};

const tdStyle: React.CSSProperties = {
  padding: "14px 16px",
  color: "#475569",
};

const tdMainStyle: React.CSSProperties = {
  padding: "14px 16px",
  color: "#0f172a",
  fontWeight: 600,
};