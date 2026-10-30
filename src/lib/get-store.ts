import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { prisma } from "./db";
import type { Store } from "@prisma/client";

export async function getStore(): Promise<Store> {
  const headerList = await headers();
  const slug = headerList.get("x-store-slug");

  if (!slug) notFound();

  const store = await prisma.store.findUnique({ where: { slug } });
  if (!store) notFound();

  return store;
}
