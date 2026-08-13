import type * as React from 'react';
import { cn } from '../../lib/utils.js';

const FIELD =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none ' +
  'placeholder:text-fg-dim focus:border-accent disabled:opacity-45';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input className={cn(FIELD, className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea className={cn(FIELD, 'resize-y leading-relaxed', className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return (
    <label
      className={cn('text-[11px] font-medium uppercase tracking-wider text-fg-dim', className)}
      {...props}
    />
  );
}
