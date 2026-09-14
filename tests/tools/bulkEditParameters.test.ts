/**
 * The mapping from `bulk_edit_documents` arguments to the `parameters` object
 * Paperless-ngx expects.
 *
 * Both cases covered here were silently broken until the integration lane put
 * them in front of a real instance, and neither could have been caught by a
 * mock: the client built a payload, the mock answered whatever it was asked,
 * and the tool reported success. What a unit test *can* do, once the correct
 * shape is known, is pin it — so these assert the exact wire shape, and the
 * integration suite asserts that a real Paperless accepts it.
 */
import { describe, expect, it } from "vitest";
import {
  buildBulkEditParameters,
  expandPageSpecification,
} from "../../src/tools/documents";

const permissionSet = {
  view: { users: [1], groups: [] },
  change: { users: [1], groups: [2] },
};

describe("buildBulkEditParameters", () => {
  describe("set_permissions", () => {
    it("flattens the permissions argument onto the top level", () => {
      const parameters = buildBulkEditParameters("set_permissions", {
        permissions: {
          set_permissions: permissionSet,
          owner: 7,
          merge: true,
        },
      });

      // Exactly this, and no `permissions` key: Paperless looks for
      // parameters["set_permissions"], and 2.16.0 does so without checking it
      // is there, which is how the nested shape produced a 500.
      expect(parameters).toEqual({
        set_permissions: permissionSet,
        owner: 7,
        merge: true,
      });
    });

    it("omits owner and merge when they were not given", () => {
      const parameters = buildBulkEditParameters("set_permissions", {
        permissions: { set_permissions: permissionSet },
      });

      expect(parameters).toEqual({ set_permissions: permissionSet });
      expect(parameters).not.toHaveProperty("owner");
      expect(parameters).not.toHaveProperty("merge");
    });

    it("keeps an explicit null owner, which clears ownership", () => {
      const parameters = buildBulkEditParameters("set_permissions", {
        permissions: { set_permissions: permissionSet, owner: null },
      });

      expect(parameters.owner).toBeNull();
    });

    it("refuses to send a request Paperless cannot answer sensibly", () => {
      // 2.16.0 turns a missing set_permissions into an opaque 500 that reads
      // like a server fault. Saying which argument is missing is worth more.
      for (const permissions of [undefined, {}, { owner: 7 }]) {
        expect(() =>
          buildBulkEditParameters("set_permissions", { permissions })
        ).toThrow(/requires the 'permissions' argument to include 'set_permissions'/);
      }
    });
  });

  describe("other methods", () => {
    it("passes simple parameters straight through", () => {
      expect(
        buildBulkEditParameters("set_correspondent", { correspondent: 3 })
      ).toEqual({ correspondent: 3 });
      expect(
        buildBulkEditParameters("modify_tags", {
          add_tags: [1, 2],
          remove_tags: [3],
        })
      ).toEqual({ add_tags: [1, 2], remove_tags: [3] });
    });

    it("never leaks the permissions grouping onto a method that has no use for it", () => {
      const parameters = buildBulkEditParameters("add_tag", {
        tag: 4,
        permissions: { set_permissions: permissionSet },
      });

      expect(parameters).toEqual({ tag: 4 });
    });

    it("expands delete_pages into the list of integers the API requires", () => {
      // `split` takes the same argument as a string and expands it server-side;
      // `delete_pages` validates `isinstance(pages, list)` and rejects the
      // string outright.
      expect(
        buildBulkEditParameters("delete_pages", { pages: "1,3,5-7" }).pages
      ).toEqual([1, 3, 5, 6, 7]);
    });

    it("leaves the split page string alone", () => {
      expect(buildBulkEditParameters("split", { pages: "1,3-4" }).pages).toBe(
        "1,3-4"
      );
    });
  });
});

describe("expandPageSpecification", () => {
  it.each([
    ["1", [1]],
    ["1,2,3", [1, 2, 3]],
    ["5-7", [5, 6, 7]],
    ["1,3,5-7", [1, 3, 5, 6, 7]],
    [" 2 , 4 - 6 ", [2, 4, 5, 6]],
    ["3-3", [3]],
  ])("expands %s", (specification, expected) => {
    expect(expandPageSpecification(specification as string)).toEqual(expected);
  });

  it.each(["", "   ", ",", "abc", "1,abc", "1-", "-3", "1..3"])(
    "rejects %s rather than sending nonsense upstream",
    (specification) => {
      expect(() => expandPageSpecification(specification)).toThrow();
    }
  );

  it("rejects a backwards range instead of silently producing nothing", () => {
    expect(() => expandPageSpecification("7-5")).toThrow(
      /end page is before the start page/
    );
  });
});
