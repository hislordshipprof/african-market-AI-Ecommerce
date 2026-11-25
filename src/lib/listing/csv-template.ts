/** The template CSV the import page offers (#782): every accepted column, one row per stock mode. */
export const LISTINGS_CSV_TEMPLATE = [
  "name,price,weight,category,stock_mode,qty,status",
  "Red Palm Oil 1L,9.99,1 kg,Palm Oil,counted,12,",
  "Ground Egusi,6.50,500 g,Soup Ingredients > Egusi & Melon Seeds,counted,20,",
  "Stockfish,14.00,1 lb,Fish & Meat > Stockfish,status,,in_stock",
  "",
].join("\n");
