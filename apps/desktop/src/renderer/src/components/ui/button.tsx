import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/utils.js';

/**
 * shadcn's Button, with the palette pointed at this app's own tokens rather
 * than Tailwind's defaults — the same variables styles.css uses, so a migrated
 * screen sits next to an unmigrated one without a visible seam.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ' +
    'disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-panel text-fg border border-line hover:border-accent',
        primary: 'bg-accent text-white border border-accent hover:opacity-90',
        subtle: 'bg-accent-soft text-accent border border-accent',
        ghost: 'text-fg-dim hover:text-accent border border-transparent',
        danger: 'bg-panel text-danger border border-line hover:border-danger',
        link: 'text-fg-dim underline underline-offset-2 hover:text-accent',
      },
      size: {
        default: 'h-8 px-3.5 py-1.5',
        sm: 'h-7 rounded-md px-2.5 text-xs',
        lg: 'h-10 px-5',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Renders the child element instead of a <button>, keeping the styling. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps): React.JSX.Element {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
