import { describe, expect, it } from "vitest";
import { isCustomerRlsRejection } from "./customer-rls-error";

describe("Customer row-level security error", () => {
  it("a generic privilege error is not a Customer row-level security rejection", () => {
    const acl = Object.assign(new Error('permission denied for table "customers"'), {
      code: "42501",
    });
    expect(isCustomerRlsRejection(acl)).toBe(false);
  });

  it("names the customers policy and SQLSTATE 42501", () => {
    const rls = Object.assign(
      new Error('new row violates row-level security policy for table "customers"'),
      { code: "42501", meta: { code: "42501" } },
    );
    expect(isCustomerRlsRejection(rls)).toBe(true);
  });

  it("rejects a customers policy message that carries a different SQLSTATE", () => {
    const other = Object.assign(
      new Error('new row violates row-level security policy for table "customers"'),
      { code: "23505" },
    );
    expect(isCustomerRlsRejection(other)).toBe(false);
  });
});
