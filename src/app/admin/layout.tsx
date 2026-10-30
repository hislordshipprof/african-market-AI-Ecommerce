import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Platform Admin",
};

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#f8f9fa]">
      {children}
    </div>
  );
}
