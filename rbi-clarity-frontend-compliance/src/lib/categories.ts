import { useEffect, useState } from "react";
import { getCategories, type CategoryOption } from "@/lib/api";

/**
 * Institution categories come from the backend (GET /categories), which
 * reads the canonical list the extraction pipeline writes. This fallback is
 * only used when the backend cannot be reached, and uses the same ids.
 */
export const FALLBACK_CATEGORIES: CategoryOption[] = [
  { id: "commercial_banks", label: "Commercial Banks" },
  { id: "small_finance_banks", label: "Small Finance Banks" },
  { id: "payments_banks", label: "Payments Banks" },
  { id: "local_area_banks", label: "Local Area Banks" },
  { id: "regional_rural_banks", label: "Regional Rural Banks" },
  { id: "urban_cooperative_banks", label: "Urban Co-operative Banks" },
  { id: "rural_cooperative_banks", label: "Rural Co-operative Banks" },
  { id: "all_india_financial_institutions", label: "All India Financial Institutions" },
  { id: "nbfc", label: "Non-Banking Financial Companies" },
  { id: "asset_reconstruction_companies", label: "Asset Reconstruction Companies" },
  { id: "credit_information_companies", label: "Credit Information Companies" },
  { id: "non_bank_ppi_issuers", label: "Non-bank PPI Issuers" },
  { id: "primary_dealers", label: "Primary Dealers" },
  { id: "multiple", label: "Multiple Regulated Entities" },
];

let cache: Promise<CategoryOption[]> | null = null;

export const loadCategories = (): Promise<CategoryOption[]> => {
  if (!cache) {
    cache = getCategories()
      .then((list) => (list.length ? list : FALLBACK_CATEGORIES))
      .catch(() => {
        cache = null; // retry next time
        return FALLBACK_CATEGORIES;
      });
  }
  return cache;
};

export const resetCategoriesCache = () => {
  cache = null;
};

/** @param includeMultiple include the "Multiple Regulated Entities" bucket (not a bank type). */
export const useCategories = (includeMultiple = true) => {
  const [categories, setCategories] = useState<CategoryOption[]>(
    includeMultiple ? FALLBACK_CATEGORIES : FALLBACK_CATEGORIES.filter((c) => c.id !== "multiple"),
  );
  useEffect(() => {
    let alive = true;
    loadCategories().then((list) => {
      if (alive) setCategories(includeMultiple ? list : list.filter((c) => c.id !== "multiple"));
    });
    return () => {
      alive = false;
    };
  }, [includeMultiple]);
  return categories;
};

export const categoryLabel = (categories: CategoryOption[], id: string | null | undefined) =>
  categories.find((c) => c.id === id)?.label ?? (id ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
