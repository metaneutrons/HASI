'use client';

import { useId, type ReactNode } from 'react';
import {
  configurationPointerChild,
  getDeclaredConfigurationFieldNames,
  getSelectedConfigurationUnionBranch,
  getVisibleConfigurationFields,
  makeConfigurationDefault,
  selectConfigurationUnionBranch,
  type ConfigurationFieldDescriptor,
  type ConfigurationJson,
  type ConfigurationSchemaNode,
  type ConfigurationValues,
} from '@/lib/plugin-configuration';

export interface PluginConfigFieldsProps {
  root: ConfigurationSchemaNode;
  values: ConfigurationValues;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (path: string, value: ConfigurationJson) => void;
  onRemove: (path: string) => void;
  onRef: (path: string, element: HTMLInputElement | HTMLSelectElement | null) => void;
}

export function PluginConfigFields({ root, values, errors, disabled, onChange, onRemove, onRef }: PluginConfigFieldsProps) {
  const prefix = useId();
  const renderBudget = { remaining: 512 };

  function idFor(path: string): string {
    return `${prefix}-${encodeURIComponent(path || 'root')}`;
  }

  function renderField(field: ConfigurationFieldDescriptor, parentPath: string, objectValue: unknown): ReactNode {
    const path = configurationPointerChild(parentPath, field.name);
    const value = objectValue !== null && typeof objectValue === 'object' && !Array.isArray(objectValue)
      ? (objectValue as Record<string, unknown>)[field.name]
      : undefined;
    return renderNode(field.node, path, value, field.required, field.label, field.help, field.unsupported);
  }

  function renderNode(
    node: ConfigurationSchemaNode,
    path: string,
    value: unknown,
    required: boolean,
    label: string,
    help?: string,
    unsupported?: string,
  ): ReactNode {
    if (renderBudget.remaining <= 0) {
      return <div key={path} role="status" style={noticeStyle}>Die Anzeigegrenze für verschachtelte Felder ist erreicht. Weitere gespeicherte Werte bleiben erhalten.</div>;
    }
    renderBudget.remaining -= 1;
    const inputId = idFor(path);
    const message = errors[path];
    const errorId = `${inputId}-error`;
    const helpId = help ? `${inputId}-help` : undefined;
    const describedBy = [helpId, message ? errorId : undefined].filter(Boolean).join(' ') || undefined;
    const commonStyle = {
      width: '100%',
      minWidth: 0,
      minHeight: 44,
      padding: '9px 10px',
      border: `1px solid ${message ? 'var(--red)' : 'var(--line-strong)'}`,
      borderRadius: 10,
      background: 'var(--surface-solid)',
      color: 'var(--ink)',
      font: 'inherit',
      fontSize: 16,
    } as const;

    if (unsupported || node.kind === 'unsupported') {
      return (
        <div key={path} role="status" style={noticeStyle}>
          <span style={{ display: 'grid', minWidth: 0, gap: 3 }}>
            <strong>{label}{required && ' · Pflichtfeld'}</strong>
            <span>{unsupported ?? (node.kind === 'unsupported' ? node.reason : 'Dieses Feld kann hier nicht bearbeitet werden.')} Der gespeicherte Wert wird erhalten.</span>
          </span>
          {message && <span id={errorId} role="alert" style={errorStyle}>{message}</span>}
        </div>
      );
    }

    if (node.kind === 'scalar') {
      const control = node.control;
      let controlElement: ReactNode;
      if (control.kind === 'string') {
        controlElement = (
          <input
            ref={(element) => { onRef(path, element); }}
            id={inputId}
            name={path}
            type="text"
            value={typeof value === 'string' ? value : ''}
            minLength={control.minLength}
            maxLength={control.maxLength}
            disabled={disabled}
            required={required}
            aria-required={required}
            aria-invalid={message ? true : undefined}
            aria-describedby={describedBy}
            style={commonStyle}
            onChange={(event) => { onChange(path, event.currentTarget.value); }}
          />
        );
      } else if (control.kind === 'number' || control.kind === 'integer') {
        controlElement = (
          <input
            ref={(element) => { onRef(path, element); }}
            id={inputId}
            name={path}
            type="number"
            inputMode="decimal"
            value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
            min={control.minimum}
            max={control.maximum}
            step={control.kind === 'integer' ? 1 : control.multipleOf ?? 'any'}
            disabled={disabled}
            required={required}
            aria-required={required}
            aria-invalid={message ? true : undefined}
            aria-describedby={describedBy}
            style={commonStyle}
            onChange={(event) => { onChange(path, event.currentTarget.value); }}
          />
        );
      } else if (control.kind === 'boolean') {
        const selected = value === true ? 'true' : value === false ? 'false' : '';
        controlElement = (
          <select
            ref={(element) => { onRef(path, element); }}
            id={inputId}
            name={path}
            value={selected}
            disabled={disabled}
            required={required}
            aria-required={required}
            aria-invalid={message ? true : undefined}
            aria-describedby={describedBy}
            style={commonStyle}
            onChange={(event) => {
              if (event.currentTarget.value === '') onRemove(path);
              else onChange(path, event.currentTarget.value === 'true');
            }}
          >
            <option value="">{required ? 'Auswählen …' : 'Nicht gesetzt'}</option>
            <option value="true">Ja</option>
            <option value="false">Nein</option>
          </select>
        );
      } else {
        const optionIndex = control.values.findIndex((candidate) => candidate === value);
        controlElement = (
          <select
            ref={(element) => { onRef(path, element); }}
            id={inputId}
            name={path}
            value={optionIndex >= 0 ? String(optionIndex) : ''}
            disabled={disabled}
            required={required}
            aria-required={required}
            aria-invalid={message ? true : undefined}
            aria-describedby={describedBy}
            style={commonStyle}
            onChange={(event) => {
              if (event.currentTarget.value === '') {
                onRemove(path);
                return;
              }
              const selected = control.values[Number(event.currentTarget.value)];
              if (selected !== undefined) onChange(path, selected);
            }}
          >
            <option value="">{required ? 'Auswählen …' : 'Nicht gesetzt'}</option>
            {control.values.map((option, index) => (
              <option key={`${typeof option}-${String(option)}-${String(index)}`} value={String(index)}>{String(option)}</option>
            ))}
          </select>
        );
      }
      return (
        <div key={path} className="form-field" style={formFieldStyle}>
          <label htmlFor={inputId}>{label}{required && <span aria-hidden="true"> *</span>}</label>
          {controlElement}
          {help && <span id={helpId} style={helpStyle}>{help}</span>}
          {message && <span id={errorId} role="alert" style={errorStyle}>{message}</span>}
        </div>
      );
    }

    if (node.kind === 'object') {
      const objectValue = isRecord(value) ? value : {};
      if (!required && value === undefined) {
        return (
          <div key={path} style={{ display: 'grid', justifyItems: 'start', gap: 6 }}>
            <button className="text-button" type="button" disabled={disabled} onClick={() => { onChange(path, makeConfigurationDefault(node)); }} style={inlineButtonStyle}>
              {label} hinzufügen
            </button>
            {help && <span style={helpStyle}>{help}</span>}
            {message && <span id={errorId} role="alert" style={errorStyle}>{message}</span>}
          </div>
        );
      }
      const fields = getVisibleConfigurationFields(node, objectValue);
      const declared = getDeclaredConfigurationFieldNames(node);
      const unknownKeys = node.strict ? Object.keys(objectValue).filter((key) => !declared.has(key)) : [];
      const groups = new Map<string, ConfigurationFieldDescriptor[]>();
      for (const field of fields) {
        const group = groups.get(field.group) ?? [];
        group.push(field);
        groups.set(field.group, group);
      }
      const nested = (
        <div style={{ display: 'grid', minWidth: 0, gap: 12 }}>
          {[...groups.entries()].map(([group, groupFields]) => (
            <fieldset key={group} style={nestedFieldsetStyle}>
              {!path && <legend style={legendStyle}>{group}</legend>}
              {path && <legend style={legendStyle}>{label}{required && ' · Pflichtfeld'}</legend>}
              {path && help && <p style={helpBlockStyle}>{help}</p>}
              <div style={{ display: 'grid', minWidth: 0, gap: 12 }}>
                {groupFields.map((field) => renderField(field, path, objectValue))}
              </div>
            </fieldset>
          ))}
          {unknownKeys.map((key) => {
            const unknownPath = configurationPointerChild(path, key);
            return (
              <div key={unknownPath} role="alert" style={noticeStyle}>
                <span>Das gespeicherte Feld „{key}“ ist im Schema nicht vorgesehen.</span>
                <button className="text-button" type="button" disabled={disabled} onClick={() => { onRemove(unknownPath); }} style={inlineButtonStyle}>Feld entfernen</button>
              </div>
            );
          })}
          {message && <p id={errorId} role="alert" style={errorStyle}>{message}</p>}
          {!required && value !== undefined && (
            <button className="text-button" type="button" disabled={disabled} onClick={() => { onRemove(path); }} style={inlineButtonStyle}>
              {label} entfernen
            </button>
          )}
        </div>
      );
      return path ? (
        <fieldset key={path} aria-describedby={describedBy} style={objectFieldsetStyle}>
          {nested}
        </fieldset>
      ) : nested;
    }

    if (node.kind === 'array') {
      const items: ConfigurationJson[] = Array.isArray(value) ? value as ConfigurationJson[] : [];
      const maxItems = node.maxItems ?? 64;
      const visibleItems = items.slice(0, 64);
      return (
        <fieldset key={path} aria-describedby={describedBy} style={objectFieldsetStyle}>
          <legend style={legendStyle}>{label}{required && ' · Pflichtfeld'}</legend>
          {help && <p style={helpBlockStyle}>{help}</p>}
          {message && <p id={errorId} role="alert" style={errorStyle}>{message}</p>}
          {value !== undefined && !Array.isArray(value) && <p role="alert" style={errorStyle}>Der gespeicherte Wert ist keine Liste.</p>}
          <div style={{ display: 'grid', minWidth: 0, gap: 10 }}>
            {visibleItems.map((item, index) => {
              const itemPath = configurationPointerChild(path, index);
              return (
                <div key={itemPath} style={arrayItemStyle}>
                  <div style={arrayItemHeadingStyle}>
                    <strong style={{ fontSize: 13 }}>Eintrag {index + 1}</strong>
                    <button className="text-button" type="button" disabled={disabled || items.length <= (node.minItems ?? 0)} onClick={() => { onRemove(itemPath); }} style={inlineButtonStyle}>Entfernen</button>
                  </div>
                  {renderNode(node.items, itemPath, item, true, node.items.kind === 'object' && node.items.title ? node.items.title : `Eintrag ${String(index + 1)}`)}
                </div>
              );
            })}
          </div>
          {items.length > 64 && <p role="alert" style={errorStyle}>Diese Liste überschreitet die Anzeigegrenze von 64 Einträgen. Werte bleiben erhalten, bis die Liste gekürzt wird.</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <button
              className="button button--secondary"
              type="button"
              disabled={disabled || items.length >= maxItems || items.length >= 64 || node.items.kind === 'unsupported'}
              onClick={() => { onChange(path, [...items, makeConfigurationDefault(node.items)]); }}
              style={smallButtonStyle}
            >
              Eintrag hinzufügen
            </button>
            {!required && value !== undefined && (
              <button className="text-button" type="button" disabled={disabled} onClick={() => { onRemove(path); }} style={inlineButtonStyle}>Liste entfernen</button>
            )}
          </div>
        </fieldset>
      );
    }

    {
      const unionValue = isRecord(value) ? value : {};
      const selected = getSelectedConfigurationUnionBranch(node, unionValue);
      const branchIndex = selected ? node.branches.indexOf(selected) : -1;
      const selectorId = `${inputId}-variant`;
      const branch = selected?.schema;
      const fields = branch
        ? getVisibleConfigurationFields(branch, unionValue).filter((field) => field.name !== node.discriminator)
        : [];
      const declared = branch ? getDeclaredConfigurationFieldNames(branch) : new Set<string>();
      const declaredByAnyBranch = new Set(node.branches.flatMap((candidate) => [...getDeclaredConfigurationFieldNames(candidate.schema)]));
      return (
        <fieldset key={path || selectorId} style={objectFieldsetStyle}>
          <legend style={legendStyle}>{label}{required && ' · Pflichtfeld'}</legend>
          {help && <p style={helpBlockStyle}>{help}</p>}
          <div className="form-field" style={formFieldStyle}>
            <label htmlFor={selectorId}>Variante</label>
            <select
              id={selectorId}
              name={configurationPointerChild(path, node.discriminator)}
              value={branchIndex >= 0 ? String(branchIndex) : ''}
              disabled={disabled}
              aria-required="true"
              aria-describedby={message ? errorId : undefined}
              aria-invalid={message ? true : undefined}
              ref={(element) => { onRef(configurationPointerChild(path, node.discriminator), element); }}
              style={commonStyle}
              onChange={(event) => {
                const nextValue = selectConfigurationUnionBranch(node, unionValue, Number(event.currentTarget.value));
                if (nextValue) onChange(path, nextValue);
              }}
            >
              <option value="">Auswählen …</option>
              {node.branches.map((candidate, index) => <option key={`${String(candidate.value)}-${String(index)}`} value={String(index)}>{candidate.label}</option>)}
            </select>
            {message && <span id={errorId} role="alert" style={errorStyle}>{message}</span>}
          </div>
          {branch && (
            <div style={{ display: 'grid', minWidth: 0, gap: 12, marginTop: 12 }}>
              {fields.map((field) => renderField(field, path, unionValue))}
              {Object.keys(unionValue).filter((key) => !declared.has(key) && !declaredByAnyBranch.has(key)).map((key) => {
                const unknownPath = configurationPointerChild(path, key);
                return (
                  <div key={unknownPath} role="alert" style={noticeStyle}>
                    <span>Das gespeicherte Feld „{key}“ gehört nicht zu dieser Variante.</span>
                    <button className="text-button" type="button" disabled={disabled} onClick={() => { onRemove(unknownPath); }} style={inlineButtonStyle}>Feld entfernen</button>
                  </div>
                );
              })}
            </div>
          )}
        </fieldset>
      );
    }
    return null;
  }

  if (root.kind === 'object') return <>{renderNode(root, '', values, true, root.title ?? 'Konfiguration', root.description)}</>;
  if (root.kind === 'union') return <>{renderNode(root, '', values, true, root.title ?? 'Konfiguration', root.description)}</>;
  return <div role="status" style={noticeStyle}>{root.kind === 'unsupported' ? root.reason : 'Dieses Schema kann hier nicht bearbeitet werden.'}</div>;
}

const noticeStyle = {
  display: 'flex',
  minWidth: 0,
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  flexWrap: 'wrap' as const,
  gap: 8,
  padding: 10,
  border: '1px solid var(--line)',
  borderRadius: 10,
  background: 'var(--surface-soft)',
  color: 'var(--ink-soft)',
  fontSize: 13,
  lineHeight: 1.5,
  overflowWrap: 'anywhere' as const,
};
const formFieldStyle = { minWidth: 0, display: 'grid', gap: 6, fontSize: 13 } as const;
const helpStyle = { color: 'var(--muted)', fontSize: 13, fontWeight: 450 } as const;
const helpBlockStyle = { margin: '0 0 9px', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 } as const;
const errorStyle = { margin: 0, color: 'var(--red)', fontSize: 13, fontWeight: 550, lineHeight: 1.45, overflowWrap: 'anywhere' as const };
const nestedFieldsetStyle = { minWidth: 0, margin: 0, padding: '8px 0 0', border: 0, borderTop: '1px solid var(--line)' } as const;
const objectFieldsetStyle = { minWidth: 0, margin: 0, padding: '8px 0 0', border: 0, borderTop: '1px solid var(--line)' } as const;
const legendStyle = { padding: '0 5px', color: 'var(--ink-soft)', fontSize: 13, fontWeight: 650 } as const;
const arrayItemStyle = { minWidth: 0, padding: 9, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-soft)' } as const;
const arrayItemHeadingStyle = { display: 'flex', minWidth: 0, alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 } as const;
const smallButtonStyle = { minHeight: 40, gap: 7 } as const;
const inlineButtonStyle = { minHeight: 36, padding: '4px 0', textAlign: 'left' as const, overflowWrap: 'anywhere' as const } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
