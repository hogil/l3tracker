from PIL import Image
import numpy as np

def dummy_analyze(image: Image.Image, sensor_value: float) -> str:
    """
    간단한 분석 함수. 실제 모델과 센서 데이터를 여기에 통합 가능.
    """
    if sensor_value > 75:
        return "주의: 센서값이 임계치를 초과했습니다. 공정 정지 가능성 높음."
    else:
        return "정상: 센서값이 안정적이며 외관상 문제 없습니다."
