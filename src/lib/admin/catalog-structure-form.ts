import { z } from "zod";

/** The languages most stores' shoppers search in, offered first; any other ISO 639 code is typed in. */
export const SYNONYM_LANGUAGES = [
  ["en", "English"],
  ["yo", "Yoruba"],
  ["ig", "Igbo"],
  ["ha", "Hausa"],
  ["tw", "Twi"],
  ["am", "Amharic"],
  ["sw", "Swahili"],
  ["so", "Somali"],
  ["pcm", "Nigerian Pidgin"],
  ["fr", "French"],
] as const;

const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(SYNONYM_LANGUAGES);

/** "Yoruba (yo)" for a listed code, the code for another, and older seeded labels such as "Yoruba" as stored. */
export function languageLabel(language: string | null): string | null {
  if (!language) return null;
  return LANGUAGE_NAMES[language] ? `${LANGUAGE_NAMES[language]} (${language})` : language;
}

const ISO_639 = /^[a-z]{2,3}$/;

export const synonymFormSchema = z
  .strictObject({
    productId: z.string().min(1).max(200),
    synonymId: z.string().min(1).max(200).optional(),
    term: z
      .string()
      .transform((value) => value.trim().replace(/\s+/g, " "))
      .pipe(z.string().min(1, "Enter the term").max(100, "Keep the term under 100 characters")),
    language: z.string().max(10),
    languageOther: z.string().max(20),
    region: z.string().trim().max(60, "Keep the region under 60 characters").transform((value) => value || null),
  })
  .transform(({ language, languageOther, ...rest }) => ({
    ...rest,
    language: (language === "other" ? languageOther : language).trim().toLowerCase() || null,
  }))
  .refine((value) => value.language === null || ISO_639.test(value.language), {
    message: "Enter a two- or three-letter ISO 639 language code, such as bm",
    path: ["language"],
  });
export type SynonymForm = z.infer<typeof synonymFormSchema>;
export type SynonymField = "term" | "language" | "region";

/** The synonym form as the schema's input. A missing text field stays undefined so the schema refuses it. */
export function readSynonymForm(form: FormData): Record<string, unknown> {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const synonymId = text("synonymId");
  return {
    productId: text("productId"),
    ...(synonymId !== undefined ? { synonymId } : {}),
    term: text("term"),
    language: text("language") ?? "",
    languageOther: text("languageOther") ?? "",
    region: text("region") ?? "",
  };
}

export const categoryFormSchema = z.strictObject({
  categoryId: z.string().min(1).max(200).optional(),
  name: z.string().trim().min(1, "Enter a name").max(60, "Keep the name under 60 characters"),
  localName: z.string().trim().max(60, "Keep the local name under 60 characters").transform((value) => value || null),
  parentId: z.string().max(200).transform((value) => value || null),
});
export type CategoryForm = z.infer<typeof categoryFormSchema>;
export type CategoryField = "name" | "localName" | "parentId";

export function readCategoryForm(form: FormData): Record<string, unknown> {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const categoryId = text("categoryId");
  return {
    ...(categoryId !== undefined ? { categoryId } : {}),
    name: text("name"),
    localName: text("localName") ?? "",
    parentId: text("parentId") ?? "",
  };
}

/** A URL slug from a category name: "Beans & Legumes" is "beans-and-legumes". */
export function categorySlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "category";
}
