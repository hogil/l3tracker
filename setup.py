from setuptools import setup, find_packages

setup(
    name="l3tracker",
    version="1.0.0",
    description="L3Tracker - Labeling and Tracking Tool",
    author="L3Tracker Team",
    packages=find_packages(),
    install_requires=[
        "fastapi>=0.104.0",
        "uvicorn[standard]>=0.24.0",
        "pydantic>=2.0.0",
        "Pillow>=10.0.0",
        "python-multipart>=0.0.6",
        "requests>=2.31.0",
        "aiofiles>=23.0.0",
    ],
    python_requires=">=3.8",
)
