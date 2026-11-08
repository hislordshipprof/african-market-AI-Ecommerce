import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Set up two-factor authentication",
};

export default function Enroll2FALayout({ children }: { children: React.ReactNode }) {
  return children;
}
