import type pg from "pg";

export interface NewSubmission {
  student: string;
  score: number;
}

export interface Submission extends NewSubmission {
  id: number;
  createdAt: Date;
}

export interface Store {
  ping(): Promise<void>;
  addSubmission(input: NewSubmission): Promise<Submission>;
  topScores(limit: number): Promise<Submission[]>;
}

const COLUMNS = `id, student, score, created_at AS "createdAt"`;

export function createPgStore(pool: pg.Pool): Store {
  return {
    async ping() {
      await pool.query("SELECT 1");
    },
    async addSubmission({ student, score }) {
      const { rows } = await pool.query<Submission>(
        `INSERT INTO submissions (student, score) VALUES ($1, $2) RETURNING ${COLUMNS}`,
        [student, score],
      );
      return rows[0]!;
    },
    async topScores(limit) {
      const { rows } = await pool.query<Submission>(
        `SELECT ${COLUMNS} FROM submissions ORDER BY score DESC, created_at ASC, id ASC LIMIT $1`,
        [limit],
      );
      return rows;
    },
  };
}
