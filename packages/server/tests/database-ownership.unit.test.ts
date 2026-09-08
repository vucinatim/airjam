import { beforeEach, describe, expect, it, vi } from "vitest";

const postgresMocks = vi.hoisted(() => ({
  create: vi.fn(),
  end: vi.fn(async () => undefined),
}));

vi.mock("postgres", () => ({
  default: postgresMocks.create,
}));

import { createOwnedServerDatabase } from "../src/db";

describe("server database ownership", () => {
  beforeEach(() => {
    postgresMocks.create.mockReset();
    postgresMocks.end.mockClear();
    const client = Object.assign(vi.fn(), {
      end: postgresMocks.end,
      options: {
        parsers: {},
        serializers: {},
      },
    });
    postgresMocks.create.mockReturnValue(client);
  });

  it("closes an owned PostgreSQL client exactly once", async () => {
    const owned = createOwnedServerDatabase(
      "postgresql://database.test/airjam",
    );
    expect(owned).not.toBeNull();

    const firstClose = owned!.close();
    const secondClose = owned!.close();

    expect(firstClose).toBe(secondClose);
    await Promise.all([firstClose, secondClose]);
    expect(postgresMocks.end).toHaveBeenCalledTimes(1);
  });

  it("does not create a resource without a database URL", () => {
    expect(createOwnedServerDatabase(undefined)).toBeNull();
    expect(postgresMocks.create).not.toHaveBeenCalled();
  });
});
