/**
 * @file プレイヤーの情報表示で、ワールドレポートの都市へ地図をズームし、その土地の写真を集めるフック
 *
 * ワールドレポートの間、Leaflet の衛星写真の地図を世界全体から都市へ飛ばし、写真を Wikipedia と
 * Wikimedia Commons から集める。座標は OpenStreetMap（Nominatim）で求める。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-18
 */

import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { InfoViewData, FullConfig } from '../types';

/**
 * ワールドレポートの都市の地図と写真。
 * @param infoView 今の情報表示（world_report のときだけ地図を出す）
 * @param config 設定（ズームの倍率と時間）
 * @returns 集めた写真・地図を描く要素の ref・ズームをやり直す関数
 */
export function useInfoViewMap(infoView: InfoViewData, config: FullConfig | null) {
  const [worldReportPhotos, setWorldReportPhotos] = useState<Array<{ url: string; title: string }>>([]);
  const infoViewMapRef        = useRef<L.Map | null>(null);
  const infoViewContainerRef  = useRef<HTMLDivElement | null>(null);
  const infoViewCoordsRef     = useRef<[number, number] | null>(null);

  useEffect(() => {
    if (!infoView || infoView.type !== 'world_report') {
      if (infoViewMapRef.current) {
        infoViewMapRef.current.remove();
        infoViewMapRef.current = null;
      }
      infoViewCoordsRef.current = null;
      setWorldReportPhotos([]);
      return;
    }
    const container = infoViewContainerRef.current;
    if (!container) return;

    if (infoViewMapRef.current) {
      infoViewMapRef.current.remove();
      infoViewMapRef.current = null;
    }
    setWorldReportPhotos([]);

    const map = L.map(container, {
      zoomControl: false, attributionControl: false,
      dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false,
    });
    map.setView([30, 0], config?.show?.display?.info_view?.world_report_zoom_start ?? 2);
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
    ).addTo(map);
    infoViewMapRef.current = map;

    // Wikipedia の記事の代表の写真と記事の中の写真を先に取る（地名で足りなければ国名で）
    const _wikiQuery = infoView.englishName || infoView.city;
    // 「Village, Country」の形なら国名を取り出しておく（足りないときに使う）
    const _countryFallback = infoView.englishName.includes(',')
      ? infoView.englishName.split(',').pop()?.trim() || ''
      : '';
    (async () => {
      const _badWords = ['flag', 'map', 'icon', 'logo', 'seal', 'coat', 'symbol', 'locator', 'blank', 'coa'];
      const _fetchWikiPhotos = async (query: string): Promise<Array<{ url: string; title: string }>> => {
        const result: Array<{ url: string; title: string }> = [];
        try {
          // サムネイル
          const summaryRes = await fetch(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`
          );
          const summary = await summaryRes.json();
          if (summary.thumbnail?.source)
            result.push({ url: summary.thumbnail.source, title: summary.description || query });

          // 記事の中の画像ファイルの一覧
          const imagesRes = await fetch(
            `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(query)}` +
            `&prop=images&imlimit=20&format=json&origin=*`
          );
          const imagesData = await imagesRes.json();
          const articlePages = Object.values(imagesData.query?.pages || {}) as any[];
          const imageFiles: string[] = (articlePages[0]?.images || [])
            .map((img: any) => img.title as string)
            .filter((t: string) => !_badWords.some(w => t.toLowerCase().includes(w)))
            .slice(0, 12);

          if (imageFiles.length > 0) {
            const infoRes = await fetch(
              `https://en.wikipedia.org/w/api.php?action=query` +
              `&titles=${encodeURIComponent(imageFiles.join('|'))}` +
              `&prop=imageinfo&iiprop=url|thumburl|mime&iiurlwidth=400&format=json&origin=*`
            );
            const infoData = await infoRes.json();
            const infoPages = Object.values(infoData.query?.pages || {}) as any[];
            result.push(...infoPages
              .filter(p => {
                const mime: string = p.imageinfo?.[0]?.mime || '';
                return p.imageinfo?.[0]?.thumburl && mime.startsWith('image/') && !mime.includes('svg');
              })
              .map(p => ({
                url: p.imageinfo[0].thumburl as string,
                title: (p.title as string).replace('File:', '').replace(/_/g, ' '),
              }))
            );
          }
        } catch { /* ignore */ }
        return result;
      };

      // まず地名で取る
      const cityPhotos = await _fetchWikiPhotos(_wikiQuery);
      setWorldReportPhotos(cityPhotos);

      // 3枚に満たず、国名が別に取れるなら、国の写真を足す
      if (cityPhotos.length < 3 && _countryFallback && _countryFallback !== _wikiQuery) {
        const countryPhotos = await _fetchWikiPhotos(_countryFallback);
        if (countryPhotos.length > 0)
          setWorldReportPhotos(prev => [...prev, ...countryPhotos]);
      }
    })();

    // 座標を探す順: 英語名 → 日本語の都市名 → 国名だけ
    const _queries: string[] = [];
    if (infoView.englishName) _queries.push(infoView.englishName);
    _queries.push(infoView.city);
    const _countryPart = infoView.englishName.split(',').pop()?.trim() || '';
    if (_countryPart && _countryPart !== infoView.englishName) _queries.push(_countryPart);

    const _geocode = async (queries: string[]): Promise<{ lat: string; lon: string } | null> => {
      for (const q of queries) {
        try {
          const r = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`
          );
          const data: Array<{ lat: string; lon: string }> = await r.json();
          if (data?.[0]) return data[0];
        } catch { /* try next */ }
      }
      return null;
    };

    _geocode(_queries).then(result => {
      if (result && infoViewMapRef.current === map) {
        const coords: [number, number] = [parseFloat(result.lat), parseFloat(result.lon)];
        infoViewCoordsRef.current = coords;
        map.flyTo(
          coords,
          config?.show?.display?.info_view?.world_report_zoom ?? 12,
          { animate: true, duration: config?.show?.display?.info_view?.zoom_duration_sec ?? 15 }
        );

        // 座標の周りの Wikimedia Commons の写真を取る
        const [lat, lon] = coords;
        (async () => {
          const _badWords = ['flag', 'map', 'coat', 'logo', 'seal', 'icon', 'locator', 'blank', 'symbol'];
          const _parsePhotos = (data: any) => {
            const pages = Object.values(data?.query?.pages || {}) as any[];
            return pages
              .filter(p => {
                const mime: string = p.imageinfo?.[0]?.mime || '';
                const title: string = (p.title || '').toLowerCase();
                const thumb: string = p.imageinfo?.[0]?.thumburl || '';
                return thumb && mime.startsWith('image/') && !mime.includes('svg') &&
                  !_badWords.some(w => title.includes(w));
              })
              .map(p => ({
                url: p.imageinfo[0].thumburl as string,
                title: (p.title as string).replace('File:', '').replace(/_/g, ' '),
              }));
          };
          // 3枚以上取れるまで半径を広げる（5km → 20km → 50km）
          for (const radius of [5000, 20000, 50000]) {
            try {
              const r = await fetch(
                `https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch` +
                `&ggscoord=${lat}|${lon}&ggsradius=${radius}&ggslimit=16` +
                `&prop=imageinfo&iiprop=url|thumburl|mime&iiurlwidth=400&format=json&origin=*`
              );
              const data = await r.json();
              const photos = _parsePhotos(data).slice(0, 6);
              if (photos.length > 0) {
                setWorldReportPhotos(prev => [...prev, ...photos]);
                if (photos.length >= 3) break;
              }
            } catch { break; }
          }
        })();
      }
    });

    return () => {
      map.remove();
      if (infoViewMapRef.current === map) infoViewMapRef.current = null;
    };
  }, [infoView]);

  const replayZoom = () => {
    const map = infoViewMapRef.current;
    const coords = infoViewCoordsRef.current;
    if (!map || !coords) return;
    map.setView([30, 0], config?.show?.display?.info_view?.world_report_zoom_start ?? 2, { animate: false });
    setTimeout(() => {
      map.flyTo(
        coords,
        config?.show?.display?.info_view?.world_report_zoom ?? 12,
        { animate: true, duration: config?.show?.display?.info_view?.zoom_duration_sec ?? 15 }
      );
    }, 300);
  };

  return { worldReportPhotos, infoViewContainerRef, replayZoom };
}
