import streamlit as st
import requests

st.set_page_config(page_title="LLM 의사결정 시스템", layout="centered")

st.title("🤖 공정 판단 AI 대시보드")

uploaded_file = st.file_uploader("🔍 검사 이미지 업로드", type=["jpg", "png"])
sensor_value = st.slider("📈 센서 수치 (예: 온도)", 0.0, 100.0, 50.0)

if st.button("분석 시작") and uploaded_file:
    with st.spinner("LLM 판단 중..."):
        response = requests.post(
            "http://localhost:8000/analyze",
            files={"image": uploaded_file},
            data={"sensor_value": sensor_value}
        )

        if response.ok:
            result = response.json()
            st.success(f"🔔 판단 결과: **{result['status']}**")
            st.write(result['message'])
        else:
            st.error("분석 실패")
