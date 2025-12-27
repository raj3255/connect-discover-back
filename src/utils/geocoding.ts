import axios from 'axios';
import { config } from '../config/env.js';
import { getRedis, setRedis } from '../config/redis.js';

interface CityResult {
  name: string;
  displayName: string;
  lat: string;
  lng: string;
  type: string;
}

export async function searchCities(query: string): Promise<CityResult[]> {
  const cached = await getRedis(`city:search:${query.toLowerCase()}`);
  if (cached) {
    return JSON.parse(cached);
  }

  try {
    const response = await axios.get(`${config.NOMINATIM_API_URL}/search`, {
      params: {
        q: query,
        format: 'json',
        limit: 10,
      },
      timeout: 5000,
    });

    if (response.data && response.data.length > 0) {
      const cities = response.data.map((r: any) => ({
        name: r.name,
        displayName: r.display_name,
        lat: r.lat,
        lng: r.lon,
        type: r.type,
      }));

      await setRedis(`city:search:${query.toLowerCase()}`, JSON.stringify(cities), 86400);
      return cities;
    }

    return [];
  } catch (error) {
    console.error('Geocoding error:', error);
    return [];
  }
}

export async function getCityCoordinates(cityName: string) {
  const cacheKey = `city:coords:${cityName.toLowerCase()}`;
  const cached = await getRedis(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  try {
    const response = await axios.get(`${config.NOMINATIM_API_URL}/search`, {
      params: {
        city: cityName,
        format: 'json',
        limit: 1,
      },
      timeout: 5000,
    });

    if (response.data && response.data.length > 0) {
      const coords = {
        lat: parseFloat(response.data[0].lat),
        lng: parseFloat(response.data[0].lon),
        displayName: response.data[0].display_name,
      };

      await setRedis(cacheKey, JSON.stringify(coords), 604800);
      return coords;
    }

    return null;
  } catch (error) {
    console.error('Geocoding error:', error);
    return null;
  }
}
