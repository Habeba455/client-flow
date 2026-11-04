import path from 'node:path';
import ExcelJS from 'exceljs';
import { createGeneratedFileFromBuffer, createGeneratedFileFromExistingPath, type GeneratedFileRouteResult } from '@/lib/generated-files/service';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const COMFORTDELGRO_TEMPLATE_PATH = path.join(process.cwd(), 'CDG_3Statement_Model_v1.0.xlsx');

interface SpreadsheetFormulaSpec {
  cell: string;
  formula: string;
  fill_down_to_row?: number;
  description?: string;
}

interface SpreadsheetSheetFormatting {
  header_fill?: string;
  header_font_color?: string;
  freeze_row?: number;
  number_format_columns?: Record<string, string>;
}

interface SpreadsheetSheetBlueprint {
  name: string;
  headers?: string[];
  column_widths?: number[];
  rows?: unknown[][];
  formulas?: SpreadsheetFormulaSpec[];
  formatting?: SpreadsheetSheetFormatting;
  totals_row?: boolean;
}

export interface SpreadsheetBlueprint {
  file_type: 'xlsx';
  filename?: string;
  sheets: SpreadsheetSheetBlueprint[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stripCodeFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function extractJsonObject(value: string): Record<string, unknown> | null {
  const cleaned = stripCodeFence(value);

  try {
    const parsed = JSON.parse(cleaned);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // Fall through to object extraction.
  }

  const start = cleaned.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = cleaned.slice(start, index + 1);
        try {
          const parsed = JSON.parse(candidate);
          return isRecord(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function normalizeFileName(fileName: string | null | undefined, fallbackBaseName: string): string {
  const sanitized =
    (fileName || fallbackBaseName)
      .trim()
      .replace(/[/\\?%*:|"<>]/g, '-')
      .replace(/\s+/g, ' ')
      .slice(0, 180) || fallbackBaseName;

  return sanitized.toLowerCase().endsWith('.xlsx') ? sanitized : `${sanitized}.xlsx`;
}

function sanitizeSheetName(name: string | null | undefined, index: number): string {
  const fallback = `Sheet${index + 1}`;
  const sanitized = (name || fallback)
    .replace(/[:\\/?*\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31);

  return sanitized || fallback;
}

function toArgb(hex: string | null | undefined, fallback: string): string {
  const normalized = (hex || '').trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(normalized)) {
    return `FF${normalized}`;
  }
  if (/^[0-9A-F]{8}$/.test(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeFormula(formula: string): string {
  return formula.trim().replace(/^=/, '');
}

function setCellValue(cell: ExcelJS.Cell, value: unknown) {
  if (value == null) {
    cell.value = null;
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) {
    cell.value = value;
    return;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('=')) {
      cell.value = { formula: normalizeFormula(trimmed) };
      return;
    }
    cell.value = value;
    return;
  }

  if (isRecord(value)) {
    const formula = getString(value.formula);
    if (formula) {
      cell.value = { formula: normalizeFormula(formula) };
      return;
    }

    const directValue = value.value;
    if (typeof directValue === 'number' || typeof directValue === 'boolean' || typeof directValue === 'string') {
      setCellValue(cell, directValue);
      return;
    }
  }

  cell.value = JSON.stringify(value);
}

function hasNumericLikeValue(cell: ExcelJS.Cell): boolean {
  if (typeof cell.value === 'number') {
    return true;
  }
  if (isRecord(cell.value) && typeof cell.value.formula === 'string') {
    return true;
  }
  if (typeof cell.value === 'string') {
    return /^=-?/.test(cell.value) || /^-?\d+(?:\.\d+)?$/.test(cell.value.trim());
  }
  return false;
}

function mapNumberFormat(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'currency') return '#,##0.0_);(#,##0.0)';
  if (normalized === 'percentage') return '0.0%';
  if (normalized === 'integer') return '#,##0_);(#,##0)';
  if (normalized === 'decimal') return '#,##0.0_);(#,##0.0)';
  return value;
}

function applyHeaderStyle(row: ExcelJS.Row, fillHex?: string, fontHex?: string) {
  const fill = toArgb(fillHex, 'FF1F4E78');
  const fontColor = toArgb(fontHex, 'FFFFFFFF');

  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: fontColor } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: fill },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD7DFEB' } },
      left: { style: 'thin', color: { argb: 'FFD7DFEB' } },
      bottom: { style: 'thin', color: { argb: 'FFD7DFEB' } },
      right: { style: 'thin', color: { argb: 'FFD7DFEB' } },
    };
  });
}

function applyNumberFormats(
  worksheet: ExcelJS.Worksheet,
  numberFormatColumns: Record<string, string> | undefined,
  startRow: number,
  endRow: number
) {
  if (!numberFormatColumns || startRow > endRow) {
    return;
  }

  for (const [column, format] of Object.entries(numberFormatColumns)) {
    const columnKey = column.trim().toUpperCase();
    if (!/^[A-Z]+$/.test(columnKey)) {
      continue;
    }

    const numFmt = mapNumberFormat(format);
    for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
      worksheet.getCell(`${columnKey}${rowNumber}`).numFmt = numFmt;
    }
  }
}

function maybeAddTotalsRow(worksheet: ExcelJS.Worksheet, headerCount: number, startRow: number, lastDataRow: number): number {
  if (headerCount <= 0 || lastDataRow < startRow) {
    return lastDataRow;
  }

  const totalRowNumber = lastDataRow + 1;
  const totalRow = worksheet.getRow(totalRowNumber);
  totalRow.getCell(1).value = 'Total';

  for (let columnIndex = 2; columnIndex <= headerCount; columnIndex += 1) {
    let shouldTotal = false;
    for (let rowNumber = startRow; rowNumber <= lastDataRow; rowNumber += 1) {
      if (hasNumericLikeValue(worksheet.getRow(rowNumber).getCell(columnIndex))) {
        shouldTotal = true;
        break;
      }
    }

    if (!shouldTotal) {
      continue;
    }

    const columnLetter = worksheet.getColumn(columnIndex).letter;
    totalRow.getCell(columnIndex).value = {
      formula: `SUBTOTAL(9,${columnLetter}${startRow}:${columnLetter}${lastDataRow})`,
    };
  }

  totalRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.border = {
      top: { style: 'double', color: { argb: 'FF94A3B8' } },
    };
  });

  return totalRowNumber;
}

function isSpreadsheetBlueprint(value: unknown): value is SpreadsheetBlueprint {
  return isRecord(value) && value.file_type === 'xlsx' && Array.isArray(value.sheets);
}

export function parseSpreadsheetBlueprint(text: string): SpreadsheetBlueprint | null {
  const parsed = extractJsonObject(text);
  return isSpreadsheetBlueprint(parsed) ? parsed : null;
}

export function isComfortDelGroFinancialModelRequest(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes('financial model') &&
    (normalized.includes('comfortdelgro') || normalized.includes('sgx: c52') || normalized.includes('sgx:c52'))
  );
}

async function renderSpreadsheetBlueprint(params: {
  userId: string;
  projectId?: string | null;
  blueprint: SpreadsheetBlueprint;
}): Promise<GeneratedFileRouteResult> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Bab Al Ilm AI';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  params.blueprint.sheets.forEach((sheet, index) => {
    const worksheet = workbook.addWorksheet(sanitizeSheetName(sheet.name, index));
    const headers = Array.isArray(sheet.headers) ? sheet.headers.map((item) => String(item ?? '')) : [];
    const rows = Array.isArray(sheet.rows) ? sheet.rows.filter((row) => Array.isArray(row)) : [];
    const columnWidths = Array.isArray(sheet.column_widths) ? sheet.column_widths : [];
    const formatting = isRecord(sheet.formatting) ? sheet.formatting : undefined;

    if (headers.length > 0) {
      worksheet.addRow(headers);
      applyHeaderStyle(worksheet.getRow(1), getString(formatting?.header_fill) || undefined, getString(formatting?.header_font_color) || undefined);
      worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: headers.length },
      };
    }

    const dataStartRow = headers.length > 0 ? 2 : 1;

    rows.forEach((row) => {
      const added = worksheet.addRow(row);
      row.forEach((value, cellIndex) => {
        setCellValue(added.getCell(cellIndex + 1), value);
      });
    });

    const formulaSpecs = Array.isArray(sheet.formulas) ? sheet.formulas : [];
    formulaSpecs.forEach((spec) => {
      if (!isRecord(spec)) {
        return;
      }

      const cellAddress = getString(spec.cell);
      const formula = getString(spec.formula);
      const fillDownToRow = getNumber(spec.fill_down_to_row);
      if (!cellAddress || !formula) {
        return;
      }

      if (fillDownToRow && fillDownToRow > 0) {
        const normalizedFormula = normalizeFormula(formula);
        const rangeMatch = cellAddress.match(/^([A-Z]+)(\d+)$/i);
        if (rangeMatch) {
          const column = (rangeMatch[1] || '').toUpperCase();
          const startRow = Number.parseInt(rangeMatch[2] || '', 10);
          if (Number.isFinite(startRow) && fillDownToRow >= startRow) {
            worksheet.fillFormula(`${column}${startRow}:${column}${fillDownToRow}`, normalizedFormula);
            return;
          }
        }
      }

      worksheet.getCell(cellAddress).value = { formula: normalizeFormula(formula) };
    });

    columnWidths.forEach((width, columnIndex) => {
      const parsedWidth = getNumber(width);
      if (parsedWidth) {
        worksheet.getColumn(columnIndex + 1).width = parsedWidth;
      }
    });

    let lastRow = worksheet.rowCount;
    if (sheet.totals_row) {
      const totalColumns = Math.max(headers.length, ...rows.map((row) => row.length), 0);
      lastRow = maybeAddTotalsRow(worksheet, totalColumns, dataStartRow, worksheet.rowCount);
    }

    const freezeRow = getNumber(formatting?.freeze_row);
    if (freezeRow && freezeRow > 0) {
      worksheet.views = [{ state: 'frozen', ySplit: freezeRow }];
    }

    applyNumberFormats(
      worksheet,
      isRecord(formatting?.number_format_columns) ? (formatting?.number_format_columns as Record<string, string>) : undefined,
      dataStartRow,
      lastRow
    );
  });

  const fileName = normalizeFileName(params.blueprint.filename, 'generated-workbook.xlsx');
  const title = fileName.replace(/\.xlsx$/i, '').replace(/[_-]+/g, ' ').trim() || 'Excel workbook';
  const bufferLike = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.isBuffer(bufferLike) ? bufferLike : Buffer.from(bufferLike as ArrayBuffer);

  return createGeneratedFileFromBuffer({
    userId: params.userId,
    projectId: params.projectId || null,
    title,
    fileName,
    mimeType: XLSX_MIME_TYPE,
    buffer,
  });
}

export async function createSpreadsheetArtifact(params: {
  userId: string;
  projectId?: string | null;
  originalPrompt: string;
  documentOutput: string;
}): Promise<GeneratedFileRouteResult> {
  if (isComfortDelGroFinancialModelRequest(params.originalPrompt)) {
    return createGeneratedFileFromExistingPath({
      userId: params.userId,
      projectId: params.projectId || null,
      title: 'ComfortDelGro 3-Statement Financial Model',
      fileName: 'CDG_3Statement_Model_v1.0.xlsx',
      mimeType: XLSX_MIME_TYPE,
      sourcePath: COMFORTDELGRO_TEMPLATE_PATH,
    });
  }

  const blueprint = parseSpreadsheetBlueprint(params.documentOutput);
  if (!blueprint) {
    throw new Error('Document Generator did not return a valid XLSX blueprint.');
  }

  return renderSpreadsheetBlueprint({
    userId: params.userId,
    projectId: params.projectId || null,
    blueprint,
  });
}
