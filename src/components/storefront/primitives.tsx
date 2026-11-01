import Link from "next/link";
import { ArrowUpRight, ShoppingBasket } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`sf-button ${className}`} {...props} />;
}
export function Chip({
  selected,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      className={`sf-chip ${className}`}
      aria-pressed={selected}
      {...props}
    />
  );
}
export function Badge({ children }: { children: ReactNode }) {
  return <span className="sf-badge">{children}</span>;
}
export function SectionHeader({
  title,
  description,
  href,
  id,
}: {
  title: string;
  description?: string;
  href?: string;
  id?: string;
}) {
  return (
    <div className="sf-section-header">
      <div>
        <h2 id={id}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {href && (
        <Link className="sf-text-link" href={href}>
          Shop all <ArrowUpRight size={18} aria-hidden />
        </Link>
      )}
    </div>
  );
}
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="sf-empty">
      <span className="sf-empty-mark">
        <ShoppingBasket size={32} aria-hidden />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {children ?? (
        <Link href="/categories" className="sf-button">
          Explore the aisles <ArrowUpRight size={18} aria-hidden />
        </Link>
      )}
    </div>
  );
}
