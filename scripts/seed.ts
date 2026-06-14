/**
 * Seed manual e idempotente do banco (postos/graduações + admin inicial).
 *
 * Substitui o antigo seed automático que rodava no caminho da request. Aqui o
 * provisionamento é explícito e fora do runtime do Worker:
 *   SEED_ADMIN_PASSWORD='...' bun run db:seed:remote   (ou :local)
 *
 * Segurança:
 * - A senha em texto puro vem só do ambiente; NUNCA é gravada em disco nem vai
 *   para a linha de comando. O que se grava é o hash PBKDF2 (mesmo formato do
 *   login), reusando o adapter real.
 * - O SQL gerado contém o hash, então é transitório: escrito com permissão 0600,
 *   aplicado via `--file` (evita o hash em argv/`ps`) e removido num `finally`.
 *   Também está no .gitignore por garantia.
 * - Idempotência via constraints UNIQUE: postos/graduações usam `abbreviation`,
 *   o militar usa `rg`. O usuário admin é criado se não existir para o militar;
 *   se já existir, apenas a senha é rotacionada — é o caminho suportado para
 *   resetar o login em produção.
 */
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";

import { WebCryptoPasswordHasherAdapter } from "../src/infra/adapters/webcrypto.password.hasher.adapter";

const DB_NAME = "18bbm_forcemap_db";
const GENERATED_FILE = "drizzle/seed.generated.sql";
const ADMIN_RG = 9999;

const RANKS: ReadonlyArray<{ abbreviation: string; order: number }> = [
  { abbreviation: "Cel", order: 1 },
  { abbreviation: "TC", order: 2 },
  { abbreviation: "Maj", order: 3 },
  { abbreviation: "Cap", order: 4 },
  { abbreviation: "1º Ten", order: 5 },
  { abbreviation: "2º Ten", order: 6 },
  { abbreviation: "Asp Of", order: 7 },
  { abbreviation: "ST", order: 8 },
  { abbreviation: "1º Sgt", order: 9 },
  { abbreviation: "2º Sgt", order: 10 },
  { abbreviation: "3º Sgt", order: 11 },
  { abbreviation: "Cb", order: 12 },
  { abbreviation: "Sd 1ª Classe", order: 13 },
  { abbreviation: "Sd 2ª Classe", order: 14 },
];

const sqlStr = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const resolveTarget = (): "--local" | "--remote" => {
  if (process.argv.includes("--remote")) return "--remote";
  if (process.argv.includes("--local")) return "--local";
  console.error("Informe o alvo: --local ou --remote.");
  process.exit(1);
};

async function main(): Promise<void> {
  const target = resolveTarget();

  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    console.error(
      "SEED_ADMIN_PASSWORD ausente no ambiente. " +
        "Ex.: SEED_ADMIN_PASSWORD='SuaSenhaForte!1' bun run db:seed:remote",
    );
    process.exit(1);
  }

  const passwordHash = await new WebCryptoPasswordHasherAdapter().hash(
    password,
  );

  const statements: string[] = [
    // Postos: idempotente via UNIQUE(abbreviation)
    ...RANKS.map(
      (r) =>
        `INSERT OR IGNORE INTO military_rank (id, abbreviation, "order") VALUES (${sqlStr(crypto.randomUUID())}, ${sqlStr(r.abbreviation)}, ${r.order});`,
    ),
    // Militar admin: encadeia o ID real do Cel via SELECT; idempotente via UNIQUE(rg)
    `INSERT OR IGNORE INTO military (id, military_rank_id, rg, name) SELECT ${sqlStr(crypto.randomUUID())}, id, ${ADMIN_RG}, ${sqlStr("Administrador")} FROM military_rank WHERE abbreviation = 'Cel';`,
    // Rotaciona senha se o usuário admin já existe
    `UPDATE "user" SET password = ${sqlStr(passwordHash)} WHERE military_id = (SELECT id FROM military WHERE rg = ${ADMIN_RG});`,
    // Cria usuário admin se ainda não existe para esse militar
    `INSERT OR IGNORE INTO "user" (id, military_id, role, password) SELECT ${sqlStr(crypto.randomUUID())}, m.id, ${sqlStr("Admin")}, ${sqlStr(passwordHash)} FROM military m WHERE m.rg = ${ADMIN_RG} AND NOT EXISTS (SELECT 1 FROM "user" WHERE military_id = m.id);`,
  ];

  writeFileSync(GENERATED_FILE, statements.join("\n") + "\n", { mode: 0o600 });

  try {
    const result = spawnSync(
      "wrangler",
      ["d1", "execute", DB_NAME, target, "--file", GENERATED_FILE],
      { stdio: "inherit", shell: process.platform === "win32" },
    );
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } finally {
    try {
      unlinkSync(GENERATED_FILE);
    } catch {
      // arquivo já removido — ok
    }
  }

  console.log(
    `\nSeed aplicado (${target}). Admin: RG ${ADMIN_RG}. Arquivo temporário removido.`,
  );
}

main();
