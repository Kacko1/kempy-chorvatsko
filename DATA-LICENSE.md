# Licence mapových dat

Datové manifesty `*_data.json` a jejich komprimované části
`map-data/*/*.json.gz` jsou odvozené z dat projektu OpenStreetMap.

- Zdroj: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
- Licence: [Open Database License 1.0 (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/)
- Regionální výřezy: [Geofabrik](https://download.geofabrik.de/)

Automatický generátor zachovává původní typ a identifikátor OSM objektu. Pro uzly používá jejich přesné souřadnice. Pro cesty a relace, které nemají jedinou bodovou souřadnici, ukládá střed obálky jejich sestavené geometrie, stejně jako dřívější dotazy Overpass `out center`.
