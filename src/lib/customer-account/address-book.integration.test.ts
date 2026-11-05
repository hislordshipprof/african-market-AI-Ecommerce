import { afterAll, describe, expect, it } from "vitest";
import { authPrisma, customerScoped } from "../db";
import { addAddress, editAddress, removeAddress, saveAccountPhone } from "./address-book";
import { ADDRESS_CAP, ADDRESS_CAP_MESSAGE, ADDRESS_NOT_FOUND } from "./address-validation";
import { getCheckoutProfile } from "./checkout-profile";

const hasDb = Boolean(process.env.DATABASE_URL);
const run = `t248-book-${Date.now()}`;

describe.skipIf(!hasDb)("address book and checkout profile", () => {
  const userId = `user-${run}`;

  afterAll(async () => {
    await authPrisma.user.deleteMany({ where: { id: { startsWith: `user-${run}` } } });
  });

  it("caps addresses, promotes a new default, and keeps the default flag on edit", async () => {
    await authPrisma.user.create({ data: { id: userId, name: "Ada <script>", email: `${userId}@example.test` } });
    const home = await addAddress(userId, {
      label: "Home",
      line1: "1 Market St",
      city: "Honolulu",
      state: "hi",
      zip: "96813",
      notes: "<script>alert(1)</script>",
      userId: "someone-else",
      isDefault: false,
    });
    expect(home.isDefault).toBe(true);
    expect(home.state).toBe("HI");
    expect(home.notes).toBe("<script>alert(1)</script>");

    const work = await addAddress(userId, {
      label: "Work",
      line1: "2 Market St",
      city: "Honolulu",
      state: "HI",
      zip: "96814",
    });
    expect(work.isDefault).toBe(false);

    const edited = await editAddress(userId, home.id, {
      label: "Home edited",
      line1: "1 Market St",
      city: "Honolulu",
      state: "HI",
      zip: "96813",
    });
    expect(edited.isDefault).toBe(true);

    await removeAddress(userId, home.id);
    const remaining = await customerScoped(userId).customerAddress.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.isDefault).toBe(true);
    expect(remaining[0]?.id).toBe(work.id);

    await expect(removeAddress(userId, home.id)).rejects.toThrow(ADDRESS_NOT_FOUND);
  });

  it("rejects the 21st address and a blank phone clear", async () => {
    const capUser = `${userId}-cap`;
    await authPrisma.user.create({ data: { id: capUser, name: "Cap", email: `${capUser}@example.test` } });
    const existing = await customerScoped(capUser).customerAddress.count();
    for (let i = existing; i < ADDRESS_CAP; i += 1) {
      await addAddress(capUser, {
        label: `Extra ${i}`,
        line1: `${i} Market St`,
        city: "Honolulu",
        state: "HI",
        zip: "96813",
      });
    }
    await expect(addAddress(capUser, {
      label: "Too many",
      line1: "99 Market St",
      city: "Honolulu",
      state: "HI",
      zip: "96813",
    })).rejects.toThrow(ADDRESS_CAP_MESSAGE);

    expect(await saveAccountPhone(capUser, "   ")).toBeNull();
    await expect(saveAccountPhone(capUser, "123")).rejects.toThrow(/phone/i);
  });

  it("concurrent adds leave a single default", async () => {
    const other = `${userId}-race`;
    await authPrisma.user.create({ data: { id: other, name: "Race", email: `${other}@example.test` } });
    const input = { line1: "1 Market St", city: "Honolulu", state: "HI", zip: "96813" };
    await Promise.all([
      addAddress(other, { ...input, label: "A" }),
      addAddress(other, { ...input, label: "B" }),
    ]);
    const rows = await customerScoped(other).customerAddress.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
    await authPrisma.user.delete({ where: { id: other } });
  });

  it("getCheckoutProfile returns only the masked shape", async () => {
    const profileUser = `${userId}-profile`;
    await authPrisma.user.create({ data: { id: profileUser, name: "Ada", email: `${profileUser}@example.test` } });
    await addAddress(profileUser, {
      label: "Home",
      line1: "1 Market St",
      city: "Honolulu",
      state: "HI",
      zip: "96813",
      notes: "<script>alert(1)</script>",
    });
    await saveAccountPhone(profileUser, "(808) 555-0100");
    const profile = await getCheckoutProfile(profileUser);
    expect(Object.keys(profile).sort()).toEqual(["addressOnFile", "card", "contactOnFile"]);
    expect(profile.contactOnFile).toBe(true);
    expect(profile.addressOnFile).toBe(true);
    expect(profile.card).toBeNull();
    const encoded = JSON.stringify(profile);
    expect(encoded).not.toMatch(/pm_|cus_|96813|Market St|<script>|555-0100/);
  });
});
