
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const extractionPrompt = `
You are an accurate Receipt Extractor Agent.

Extract expense information from the uploaded receipt image or PDF.
Return only a valid JSON object.

Use this exact structure:
{
  "extraction_confidence": "HIGH",
  "confidence_notes": null,
  "vendor": {
    "name": null,
    "address": null,
    "phone": null,
    "website": null
  },
  "receipt": {
    "receipt_number": null,
    "date": null,
    "time": null,
    "payment_method": null
  },
  "line_items": [],
  "subtotal": null,
  "discount": null,
  "tax": null,
  "tip": null,
  "total": null,
  "currency": null,
  "category_suggestion": null,
  "category_reasoning": null,
  "billable_suggestion": null,
  "billable_reasoning": null,
  "project_relevance": null
}

Rules:
- Extract all visible line items.
- Each line item contains description, quantity, unit_price, total.
- Use numbers for monetary values, not strings.
- Format dates as YYYY-MM-DD and times as HH:MM.
- Payment method: cash, card, bank_transfer, unknown, or null.
- Use null for missing information.
- Never invent information.
- Set extraction_confidence to HIGH, MEDIUM, or LOW.
- Return valid JSON only.
`;

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is missing" },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const uploaded = formData.get("file");

    if (!(uploaded instanceof File)) {
      return NextResponse.json(
        { error: "No file uploaded" },
        { status: 400 }
      );
    }

    const file = uploaded;
    const allowedTypes = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: "Unsupported file type" },
        { status: 400 }
      );
    }

    if (file.size === 0 || file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File must be between 1 byte and 10 MB" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = buffer.toString("base64");

    const attachment =
      file.type === "application/pdf"
        ? {
            type: "input_file",
            filename: file.name || "receipt.pdf",
            file_data: `data:application/pdf;base64,${base64}`
          }
        : {
            type: "input_image",
            image_url: `data:${file.type};base64,${base64}`
          };

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          store: false,
          max_output_tokens: 2600,
          text: {
            format: { type: "json_object" }
          },
          input: [
            {
              role: "system",
              content: extractionPrompt
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Extract all receipt data as JSON."
                },
                attachment
              ]
            }
          ]
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);

      console.error(
        "OpenAI request failed:",
        response.status,
        errorData?.error?.message || "Unknown error"
      );

      return NextResponse.json(
        { error: "OpenAI extraction request failed" },
        { status: 502 }
      );
    }

    const result = await response.json();

    const text = (result.output || [])
      .flatMap((item: any) => item.content || [])
      .filter((part: any) => part.type === "output_text")
      .map((part: any) => part.text || "")
      .join("")
      .trim();

    if (result.status !== "completed" || !text) {
      return NextResponse.json(
        { error: "Incomplete AI extraction response" },
        { status: 502 }
      );
    }

    let data: any;

    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON from OpenAI" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      extraction_confidence: data.extraction_confidence ?? null,
      confidence_notes: data.confidence_notes ?? null,
      vendor: data.vendor ?? null,
      receipt: data.receipt ?? null,
      line_items: data.line_items ?? [],
      subtotal: data.subtotal ?? null,
      discount: data.discount ?? null,
      tax: data.tax ?? null,
      tip: data.tip ?? null,
      total: data.total ?? null,
      currency: data.currency ?? null,
      category_suggestion: data.category_suggestion ?? null,
      category_reasoning: data.category_reasoning ?? null,
      billable_suggestion: data.billable_suggestion ?? null,
      billable_reasoning: data.billable_reasoning ?? null,
      project_relevance: data.project_relevance ?? null
    });
  } catch (error) {
    console.error("Receipt extraction error:", error);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
