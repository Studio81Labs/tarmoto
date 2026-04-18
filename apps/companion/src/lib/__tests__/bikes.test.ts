import {
  EMPTY_BIKE_FORM,
  MIN_BIKE_YEAR,
  bikeToFormValues,
  formValuesToPayload,
  formatBikeTitle,
  hasErrors,
  maxBikeYear,
  validateBikeForm,
} from "../bikes";
import type { Bike } from "../types";

const FIXED_NOW = new Date("2026-06-15T00:00:00Z");

describe("validateBikeForm", () => {
  it("flags every missing required field", () => {
    const errors = validateBikeForm(EMPTY_BIKE_FORM, FIXED_NOW);
    expect(errors.make).toBeDefined();
    expect(errors.model).toBeDefined();
    expect(errors.year).toBeDefined();
  });

  it("accepts a valid form", () => {
    const errors = validateBikeForm(
      { make: "Yamaha", model: "MT-09", year: "2024", photoUrl: "" },
      FIXED_NOW,
    );
    expect(errors).toEqual({});
  });

  it("rejects non-4-digit years", () => {
    expect(
      validateBikeForm(
        { make: "A", model: "B", year: "99", photoUrl: "" },
        FIXED_NOW,
      ).year,
    ).toBeDefined();
    expect(
      validateBikeForm(
        { make: "A", model: "B", year: "20a4", photoUrl: "" },
        FIXED_NOW,
      ).year,
    ).toBeDefined();
  });

  it("rejects years outside the allowed range", () => {
    expect(
      validateBikeForm(
        { make: "A", model: "B", year: "1800", photoUrl: "" },
        FIXED_NOW,
      ).year,
    ).toBeDefined();
    // maxBikeYear(FIXED_NOW) === 2027
    expect(
      validateBikeForm(
        { make: "A", model: "B", year: "2030", photoUrl: "" },
        FIXED_NOW,
      ).year,
    ).toBeDefined();
  });

  it("allows next year (manufacturers release mid-season)", () => {
    expect(
      validateBikeForm(
        { make: "A", model: "B", year: "2027", photoUrl: "" },
        FIXED_NOW,
      ).year,
    ).toBeUndefined();
  });

  it("rejects non-http photo URLs", () => {
    expect(
      validateBikeForm(
        { make: "A", model: "B", year: "2024", photoUrl: "ftp://host/img.png" },
        FIXED_NOW,
      ).photoUrl,
    ).toBeDefined();
    expect(
      validateBikeForm(
        { make: "A", model: "B", year: "2024", photoUrl: "not a url" },
        FIXED_NOW,
      ).photoUrl,
    ).toBeDefined();
  });

  it("accepts an empty photo URL as valid", () => {
    expect(
      validateBikeForm(
        { make: "A", model: "B", year: "2024", photoUrl: "" },
        FIXED_NOW,
      ).photoUrl,
    ).toBeUndefined();
    expect(
      validateBikeForm(
        { make: "A", model: "B", year: "2024", photoUrl: "   " },
        FIXED_NOW,
      ).photoUrl,
    ).toBeUndefined();
  });

  it("treats whitespace-only make/model as missing", () => {
    const errors = validateBikeForm(
      { make: "   ", model: "   ", year: "2024", photoUrl: "" },
      FIXED_NOW,
    );
    expect(errors.make).toBeDefined();
    expect(errors.model).toBeDefined();
  });
});

describe("formValuesToPayload", () => {
  it("trims strings and coerces year to a number", () => {
    expect(
      formValuesToPayload({
        make: "  Yamaha  ",
        model: "  MT-09  ",
        year: " 2024 ",
        photoUrl: "  https://example.com/mt09.jpg  ",
      }),
    ).toEqual({
      make: "Yamaha",
      model: "MT-09",
      year: 2024,
      photoUrl: "https://example.com/mt09.jpg",
    });
  });

  it("maps an empty photo URL to null", () => {
    expect(
      formValuesToPayload({
        make: "Yamaha",
        model: "MT-09",
        year: "2024",
        photoUrl: "   ",
      }).photoUrl,
    ).toBeNull();
  });
});

describe("bikeToFormValues", () => {
  it("projects a stored bike into editable strings", () => {
    const bike: Bike = {
      id: "b1",
      make: "Yamaha",
      model: "MT-09",
      year: 2024,
      photoUrl: "https://example.com/mt09.jpg",
      isActive: true,
      totalKm: 1234,
    };
    expect(bikeToFormValues(bike)).toEqual({
      make: "Yamaha",
      model: "MT-09",
      year: "2024",
      photoUrl: "https://example.com/mt09.jpg",
    });
  });

  it("renders a missing photoUrl as an empty string", () => {
    const bike: Bike = {
      id: "b1",
      make: "Yamaha",
      model: "MT-09",
      year: 2024,
      isActive: false,
      totalKm: 0,
    };
    expect(bikeToFormValues(bike).photoUrl).toBe("");
  });
});

describe("formatBikeTitle", () => {
  it("joins make and model", () => {
    expect(formatBikeTitle({ make: "Yamaha", model: "MT-09" })).toBe(
      "Yamaha MT-09",
    );
  });
});

describe("hasErrors", () => {
  it("returns false for empty object", () => {
    expect(hasErrors({})).toBe(false);
  });
  it("returns true when any field has an error", () => {
    expect(hasErrors({ make: "Required" })).toBe(true);
  });
});

describe("year bounds", () => {
  it("MIN_BIKE_YEAR is 1900", () => {
    expect(MIN_BIKE_YEAR).toBe(1900);
  });
  it("maxBikeYear is currentYear + 1", () => {
    expect(maxBikeYear(FIXED_NOW)).toBe(2027);
  });
});
