call venv\Scripts\activate.bat

pip install -e ".[dev]"
pytest
