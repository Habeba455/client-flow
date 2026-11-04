'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, X } from 'lucide-react';

interface DateTimePickerProps {
  value: string;
  onChange: (value: string) => void;
  includeTime?: boolean;
  placeholder?: string;
}

interface ParsedValue {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const HOUR_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);
const MINUTE_OPTIONS = ['00', '15', '30', '45'];

function parseValue(value: string): ParsedValue | null {
  if (!value) return null;
  const [datePart, timePart] = value.split('T');
  if (!datePart) return null;
  const [yearText, monthText, dayText] = datePart.split('-');
  const [hourText = '09', minuteText = '00'] = (timePart || '').split(':');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if ([year, month, day].some((part) => Number.isNaN(part))) return null;
  return { year, month, day, hour: Number.isNaN(hour) ? 9 : hour, minute: Number.isNaN(minute) ? 0 : minute };
}

function toValue(parts: ParsedValue, includeTime: boolean): string {
  const date = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  if (!includeTime) return date;
  return `${date}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function formatDisplay(value: string, includeTime: boolean): string {
  const parsed = parseValue(value);
  if (!parsed) return '';
  const date = new Date(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(date);
}

function buildMonthDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPreviousMonth = new Date(year, month, 0).getDate();
  const cells: Array<{ year: number; month: number; day: number; inCurrentMonth: boolean }> = [];

  for (let index = startWeekday - 1; index >= 0; index -= 1) {
    cells.push({
      year,
      month: month - 1,
      day: daysInPreviousMonth - index,
      inCurrentMonth: false,
    });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ year, month, day, inCurrentMonth: true });
  }

  while (cells.length % 7 !== 0) {
    const nextDay = cells.length - (startWeekday + daysInMonth) + 1;
    cells.push({ year, month: month + 1, day: nextDay, inCurrentMonth: false });
  }

  return cells.map((cell) => {
    const normalized = new Date(cell.year, cell.month, cell.day);
    return {
      year: normalized.getFullYear(),
      month: normalized.getMonth(),
      day: normalized.getDate(),
      inCurrentMonth: cell.inCurrentMonth,
    };
  });
}

export function DateTimePicker({
  value,
  onChange,
  includeTime = false,
  placeholder = includeTime ? 'Select date and time' : 'Select date',
}: DateTimePickerProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const parsedValue = parseValue(value);
  const today = new Date();
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() =>
    parsedValue ? new Date(parsedValue.year, parsedValue.month - 1, 1) : new Date(today.getFullYear(), today.getMonth(), 1)
  );

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    if (parsedValue) {
      setVisibleMonth(new Date(parsedValue.year, parsedValue.month - 1, 1));
    }
  }, [parsedValue?.year, parsedValue?.month]);

  const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(visibleMonth);
  const calendarDays = useMemo(
    () => buildMonthDays(visibleMonth.getFullYear(), visibleMonth.getMonth()),
    [visibleMonth]
  );

  const commitDate = (year: number, month: number, day: number) => {
    const nextValue = parsedValue || {
      year,
      month: month + 1,
      day,
      hour: 9,
      minute: 0,
    };
    onChange(
      toValue(
        {
          ...nextValue,
          year,
          month: month + 1,
          day,
        },
        includeTime
      )
    );
    if (!includeTime) {
      setOpen(false);
    }
  };

  const updateTime = (nextHour: number, nextMinute: number) => {
    const base = parsedValue || {
      year: today.getFullYear(),
      month: today.getMonth() + 1,
      day: today.getDate(),
      hour: 9,
      minute: 0,
    };
    onChange(
      toValue(
        {
          ...base,
          hour: nextHour,
          minute: nextMinute,
        },
        true
      )
    );
  };

  const selectedHour12 = parsedValue ? ((parsedValue.hour + 11) % 12) + 1 : 9;
  const selectedMinute = parsedValue ? String(parsedValue.minute).padStart(2, '0') : '00';
  const selectedMeridiem = parsedValue && parsedValue.hour >= 12 ? 'PM' : 'AM';

  return (
    <div className="custom-picker" ref={wrapperRef}>
      <button type="button" className={`custom-picker-trigger ${open ? 'is-open' : ''}`} onClick={() => setOpen((current) => !current)}>
        <span>{value ? formatDisplay(value, includeTime) : placeholder}</span>
        <span className="custom-picker-trigger-icons">
          {includeTime ? <Clock3 size={15} /> : null}
          <CalendarDays size={15} />
        </span>
      </button>

      {open ? (
        <div className="custom-picker-popover">
          <div className="custom-picker-header">
            <strong>{monthLabel}</strong>
            <div className="custom-picker-nav">
              <button type="button" onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1))}>
                <ChevronLeft size={16} />
              </button>
              <button type="button" onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1))}>
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          <div className="custom-picker-weekdays">
            {WEEKDAY_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>

          <div className="custom-picker-grid">
            {calendarDays.map((day) => {
              const isSelected =
                parsedValue &&
                parsedValue.year === day.year &&
                parsedValue.month === day.month + 1 &&
                parsedValue.day === day.day;

              return (
                <button
                  key={`${day.year}-${day.month}-${day.day}`}
                  type="button"
                  className={`custom-picker-day ${day.inCurrentMonth ? '' : 'is-muted'} ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => commitDate(day.year, day.month, day.day)}
                >
                  {day.day}
                </button>
              );
            })}
          </div>

          {includeTime ? (
            <div className="custom-picker-time">
              <select
                value={String(selectedHour12)}
                onChange={(event) => {
                  const nextHour12 = Number(event.target.value);
                  const nextHour24 = selectedMeridiem === 'PM' ? (nextHour12 % 12) + 12 : nextHour12 % 12;
                  updateTime(nextHour24, Number(selectedMinute));
                }}
              >
                {HOUR_OPTIONS.map((hour) => (
                  <option key={hour} value={hour}>
                    {hour}
                  </option>
                ))}
              </select>
              <span>:</span>
              <select value={selectedMinute} onChange={(event) => updateTime(parsedValue?.hour || 9, Number(event.target.value))}>
                {MINUTE_OPTIONS.map((minute) => (
                  <option key={minute} value={minute}>
                    {minute}
                  </option>
                ))}
              </select>
              <select
                value={selectedMeridiem}
                onChange={(event) => {
                  const meridiem = event.target.value;
                  const nextHour24 = meridiem === 'PM' ? (selectedHour12 % 12) + 12 : selectedHour12 % 12;
                  updateTime(nextHour24, Number(selectedMinute));
                }}
              >
                <option value="AM">AM</option>
                <option value="PM">PM</option>
              </select>
            </div>
          ) : null}

          <div className="custom-picker-actions">
            <button
              type="button"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              <X size={14} />
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                onChange(
                  toValue(
                    {
                      year: now.getFullYear(),
                      month: now.getMonth() + 1,
                      day: now.getDate(),
                      hour: includeTime ? now.getHours() : 9,
                      minute: includeTime ? now.getMinutes() - (now.getMinutes() % 15) : 0,
                    },
                    includeTime
                  )
                );
                setVisibleMonth(new Date(now.getFullYear(), now.getMonth(), 1));
              }}
            >
              Today
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
