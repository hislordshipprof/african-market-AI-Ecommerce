-- Read-only store catalog over MCP (#572): off until the store owner opts in.
ALTER TABLE "stores" ADD COLUMN "ai_catalog_readable" BOOLEAN NOT NULL DEFAULT false;
