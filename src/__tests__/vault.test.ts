import { expect, test, describe } from "vitest";
import { globalCredentialVault } from "../middlewares/vault.js";

describe("Credential Vault Zero-Trust", () => {
  test("getSecret and setSecret should NOT accept tenantId as an argument", () => {
    // Để ngăn chặn Zero-Trust escalation (plugin truyền láo tenantId của người khác),
    // hàm Vault KHÔNG ĐƯỢC nhận tham số tenantId. Nó phải tự tự động lấy từ ENV/Context.
    
    // Kiểm tra cấu trúc interface (qua property length của function)
    expect(globalCredentialVault.getSecret.length).toBe(1); 
    expect(globalCredentialVault.setSecret.length).toBe(2); 
  });
});
