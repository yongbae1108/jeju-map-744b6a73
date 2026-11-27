# 제주 여행 지도

제주 섬 전체를 담은 3D 지도에 여행 일정을 넣고, 실제 도로를 따라 동선을 미리 보는 웹앱입니다.
휴대폰에서 홈 화면에 추가하면 인터넷 없이도 열립니다. 일정은 각자 기기(브라우저)에 저장되고 이 저장소나 사이트로 올라오지 않습니다.

여러 기기에서 같은 일정을 쓰는 '기기 간 동기화'는 켠 사람만 씁니다. 켜면 일정은 기기에서 암호화(AES-GCM)된 뒤 Firebase Realtime Database에 보관되고, 열쇠는 동기화 링크의 `#` 뒤에만 있어 서버는 내용을 읽을 수 없습니다.

## 자료와 라이선스

- 도로·건물·숲·장소: © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/)
- 지형: Mapzen Terrain Tiles (SRTM, GMTED2010, ETOPO1 등)
- 3D 그리기: [three.js](https://threejs.org/) r128 (MIT)
- 글꼴: 나눔고딕, Fraunces (SIL Open Font License 1.1, `fonts/OFL-*.txt`)
- 주소 검색: Esri ArcGIS World Geocoder (검색어만 Esri로 전송)
- 기기 간 동기화: Google Firebase Realtime Database (켠 경우에만, 암호문만 전송)
