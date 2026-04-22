import {
  buildCommunityRideQuery,
  type CommunityFeedLocation,
} from "../community-feed";

const place: CommunityFeedLocation = {
  label: "Brno, Czechia",
  lat: 49.1951,
  lng: 16.6068,
  km: 50,
};

describe("buildCommunityRideQuery", () => {
  it("includes place, distance, and nearest sort when a location is selected", () => {
    expect(
      buildCommunityRideQuery({
        sort: "nearest",
        rideType: "trip",
        minQuality: "4",
        minPopularity: "250",
        minCurviness: "6",
        minDistanceKm: "150",
        maxDistanceKm: "320",
        location: place,
        limit: 9,
        offset: 18,
      }),
    ).toEqual({
      sort: "nearest",
      ride_type: "trip",
      min_quality: 4,
      min_popularity: 250,
      min_curviness: 6,
      min_distance_km: 150,
      max_distance_km: 320,
      lat: 49.1951,
      lng: 16.6068,
      radius_km: 50,
      limit: 9,
      offset: 18,
    });
  });

  it("falls back from nearest to most_popular when no location is selected", () => {
    expect(
      buildCommunityRideQuery({
        sort: "nearest",
        rideType: "all",
        minQuality: "all",
        minPopularity: "all",
        minCurviness: "all",
        minDistanceKm: "",
        maxDistanceKm: "",
        location: null,
        limit: 9,
        offset: 0,
      }),
    ).toEqual({
      sort: "most_popular",
      limit: 9,
      offset: 0,
    });
  });
});
