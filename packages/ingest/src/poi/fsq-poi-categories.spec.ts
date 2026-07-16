import { ACCOMMODATION_KINDS } from "@tarmoto/shared";
import { classifyFsqKind, fsqRowToImportRow } from "./fsq-poi-categories.js";
import type { FsqPlaceRow } from "./fsq-poi-categories.js";

describe("classifyFsqKind", () => {
  it.each([
    ["Restaurant", "restaurant"],
    ["Café", "cafe"],
    ["Coffee Shop", "cafe"],
    ["Fast Food Restaurant", "fast_food"],
    ["Ice Cream Parlor", "ice_cream"],
    ["Gas Station", "fuel_station"],
    ["Scenic Lookout", "viewpoint"],
    ["Rest Area", "rest_area"],
    ["Hotel", "hotel"],
    ["Motel", "motel"],
    ["Hostel", "hostel"],
    ["Bed and Breakfast", "guest_house"],
    ["Vacation Rental", "chalet"],
    ["Serviced Apartment", "apartment"],
    ["Campground", "camp_site"],
  ])("maps %s → %s", (label, kind) => {
    expect(classifyFsqKind([label])).toBe(kind);
  });

  it("classifies a hierarchical label path by its leaf", () => {
    expect(classifyFsqKind(["Landmarks and Outdoors > Scenic Lookout"])).toBe(
      "viewpoint",
    );
  });

  it("respects FSQ's category order — the primary category decides", () => {
    // A restaurant that also lists a café category, and vice versa.
    expect(classifyFsqKind(["Restaurant", "Café"])).toBe("restaurant");
    expect(classifyFsqKind(["Café", "Restaurant"])).toBe("cafe");
    // A restaurant inside a hotel, listed primary-Restaurant, is a restaurant.
    expect(classifyFsqKind(["Restaurant", "Hotel"])).toBe("restaurant");
  });

  it("prefers the specific food kind over the generic restaurant in one label", () => {
    expect(classifyFsqKind(["Fast Food Restaurant"])).toBe("fast_food");
  });

  it("returns null for a category we do not serve, or an empty list", () => {
    expect(classifyFsqKind(["Bank"])).toBeNull();
    expect(classifyFsqKind([])).toBeNull();
  });
});

describe("fsqRowToImportRow", () => {
  const base: FsqPlaceRow = {
    fsq_place_id: "abc123",
    name: "U Fleku",
    latitude: 50.08,
    longitude: 14.42,
    category_ids: "4bf58dd8d48988d1c4941735",
    category_labels: "Restaurant",
    tel: "+420 111 222 333",
    website: "https://ufleku.cz",
    address: "Křemencova 11",
    locality: "Praha",
    postcode: "110 00",
    country: "cz",
  };

  it("maps a full FSQ row to the normalized import row", () => {
    expect(fsqRowToImportRow(base)).toEqual({
      external_id: "fsq:abc123",
      kind: "restaurant",
      name: "U Fleku",
      website: "https://ufleku.cz",
      phone: "+420 111 222 333",
      lat: 50.08,
      lng: 14.42,
      opening_hours: null,
      address_street: "Křemencova 11",
      address_city: "Praha",
      address_postcode: "110 00",
      address_country: "CZ", // normalized to upper-case ISO-2
      cuisine: null,
      brand: null,
      stars: null, // OS Places carries no ratings (#851)
      tags: { fsq_category_ids: "4bf58dd8d48988d1c4941735" },
    });
  });

  it("drops a row whose categories map to nothing we serve", () => {
    expect(
      fsqRowToImportRow({ ...base, category_labels: "Bank,ATM" }),
    ).toBeNull();
  });

  it("drops a row missing an id or a finite coordinate", () => {
    expect(fsqRowToImportRow({ ...base, fsq_place_id: "" })).toBeNull();
    expect(fsqRowToImportRow({ ...base, latitude: NaN })).toBeNull();
  });

  it("nulls blank fields and a non-2-letter country", () => {
    const row = fsqRowToImportRow({
      ...base,
      name: "   ",
      tel: "",
      website: null,
      country: "Czechia",
      category_ids: null,
    });
    expect(row).toMatchObject({
      name: null,
      phone: null,
      website: null,
      address_country: null,
      tags: null,
    });
  });

  it("only ever emits kinds in the shared store vocabulary", () => {
    // Every accommodation kind we map must be a real ACCOMMODATION_KIND.
    const accommodationMapped = [
      "Hotel",
      "Motel",
      "Hostel",
      "Bed and Breakfast",
      "Vacation Rental",
      "Serviced Apartment",
      "Campground",
    ].map((label) => classifyFsqKind([label]));
    for (const kind of accommodationMapped) {
      expect(ACCOMMODATION_KINDS).toContain(kind);
    }
  });
});
