import { existsSync } from 'node:fs'

let loaded = false

/** Loads the gitignored .env (never printed) and returns the test database URL. */
export function testDatabaseUrl(): string {
  if (!loaded) {
    loaded = true
    if (existsSync('.env')) process.loadEnvFile('.env')
  }
  const url = process.env.DATABASE_URL_TEST
  if (!url) throw new Error('DATABASE_URL_TEST is not set (copy .env.example to .env)')
  return url
}
