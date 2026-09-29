import React, { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Option = {
  id: string;
  name: string;
  model: string;
  provider: string;
  providerName?: string;
  available: boolean;
};
type Props = {
  options: Option[];
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  multiple?: boolean;
  t: (en: string, ko: string) => string;
};

export function ModelPicker({
  options,
  value,
  onChange,
  label,
  description,
  disabled,
  multiple = false,
  t,
}: Props) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [active, setActive] = useState(0),
    [limit, setLimit] = useState(100);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null);
  const id = useId();
  const group = (o: Option) =>
    o.providerName ??
    (o.provider === 'baseline' || o.provider === 'local'
      ? t('Local controllers', '로컬 플레이어')
      : o.provider);
  const filtered = options
    .filter((o) => `${o.name} ${o.model} ${group(o)}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => group(a).localeCompare(group(b)) || a.name.localeCompare(b.name));
  const visible = filtered.slice(0, limit);
  const blocked = (o: Option) =>
    !o.available || (multiple && value.length >= 12 && !value.includes(o.id));
  const close = (restore = true) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  const choose = (o: Option) => {
    if (blocked(o)) return;
    onChange(
      multiple
        ? value.includes(o.id)
          ? value.filter((v) => v !== o.id)
          : [...value, o.id]
        : [o.id],
    );
    if (!multiple) close();
  };
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect(),
        width = Math.min(440, window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 12,
        above = rect.top - 12;
      const upwards = below < 300 && above > below;
      setPosition({
        position: 'fixed',
        width,
        left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12),
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
        maxHeight: Math.max(150, Math.min(440, upwards ? above : below)),
      });
    };
    place();
    search.current?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      if (
        !trigger.current?.contains(e.target as Node) &&
        !popup.current?.contains(e.target as Node)
      )
        close(false);
    };
    const scroll = (e: Event) => {
      if (!popup.current?.contains(e.target as Node)) place();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const option = document.getElementById(`${id}-option-${active}`);
    const list = option?.parentElement;
    if (!option || !list) return;
    const row = option.getBoundingClientRect(),
      bounds = list.getBoundingClientRect();
    if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
  }, [active, open]);
  const selected = options.find((o) => o.id === value[0]);
  return (
    <div className="model-select">
      <button
        ref={trigger}
        type="button"
        className="model-select-trigger"
        aria-label={label}
        aria-describedby={description ? `${id}-hint` : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        disabled={disabled}
        onClick={() => {
          setQuery('');
          setLimit(100);
          setActive(0);
          setOpen((p) => !p);
        }}
      >
        <span>
          {multiple
            ? t(`${value.length} models selected`, `${value.length}개 모델 선택`)
            : (selected?.name ?? (value[0] || t('Choose a model', '모델 선택')))}
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {description && (
        <p className="model-select-hint" id={`${id}-hint`}>
          {description}
        </p>
      )}
      {open &&
        createPortal(
          <div
            className="model-select-popup"
            ref={popup}
            style={position}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
              if (e.key === 'Tab') {
                const fields = [...popup.current!.querySelectorAll('input,button:not(:disabled)')];
                const index = fields.indexOf(document.activeElement!);
                if ((e.shiftKey && index === 0) || (!e.shiftKey && index === fields.length - 1)) {
                  e.preventDefault();
                  close();
                }
              }
            }}
          >
            <input
              ref={search}
              type="search"
              role="combobox"
              aria-label={t('Search models', '모델 검색')}
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={visible[active] ? `${id}-option-${active}` : undefined}
              value={query}
              placeholder={t('Search models or providers…', '모델 또는 공급자 검색…')}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
                setLimit(100);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  let next = active;
                  for (let i = 0; i < filtered.length; i++) {
                    next = (next + step + filtered.length) % filtered.length;
                    if (!blocked(filtered[next])) break;
                  }
                  if (next >= limit) setLimit(Math.ceil((next + 1) / 100) * 100);
                  setActive(next);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (visible[active]) choose(visible[active]);
                }
              }}
            />
            <div
              className="model-select-results"
              role="listbox"
              id={`${id}-list`}
              aria-label={label}
              aria-multiselectable={multiple || undefined}
            >
              {visible.map((o, i) => (
                <React.Fragment key={o.id}>
                  {(i === 0 || group(visible[i - 1]) !== group(o)) && (
                    <div className="model-select-group" role="presentation">
                      {group(o)}
                    </div>
                  )}
                  <div
                    id={`${id}-option-${i}`}
                    role="option"
                    aria-selected={value.includes(o.id)}
                    aria-disabled={blocked(o)}
                    className={`model-select-option ${active === i ? 'active' : ''}`}
                    onPointerMove={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(o)}
                  >
                    <span className="model-select-check" aria-hidden="true">
                      {value.includes(o.id) ? '✓' : ''}
                    </span>
                    <span>
                      <strong>{o.name}</strong>
                      <small>
                        {o.model}
                        {!o.available ? t(' · setup required', ' · 설정 필요') : ''}
                      </small>
                    </span>
                  </div>
                </React.Fragment>
              ))}
              {!filtered.length && (
                <p className="empty">{t('No matching models', '검색 결과가 없습니다')}</p>
              )}
            </div>
            <div className="model-select-footer">
              <span>
                {filtered.length} {t('models', '개 모델')}
                {multiple ? ` · ${value.length}/12` : ''}
              </span>
              {filtered.length > limit && (
                <button className="text-button" onClick={() => setLimit((p) => p + 100)}>
                  {t('Show more', '더 보기')}
                </button>
              )}
              {multiple && (
                <button className="text-button" onClick={() => close()}>
                  {t('Done', '완료')}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
