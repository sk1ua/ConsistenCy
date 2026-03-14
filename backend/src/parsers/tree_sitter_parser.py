# -*- coding: utf-8 -*-
"""
Tree-sitter Parser
==================
Multi-language parser using tree-sitter.
Supports JavaScript, TypeScript, and future languages.
"""
from __future__ import annotations

from typing import Any

try:
    from tree_sitter import Language, Parser as TSParser, Tree
    HAS_TREE_SITTER = True
except ImportError:
    HAS_TREE_SITTER = False

from .base_parser import BaseParser, ParseSnapshot, FunctionInfo, ClassInfo, ImportInfo


# Language module cache
_language_cache: dict[str, Any] = {}


def _get_language(lang_name: str) -> Any:
    """Load tree-sitter language grammar (with caching)."""
    if lang_name in _language_cache:
        return _language_cache[lang_name]
    
    if not HAS_TREE_SITTER:
        return None
    
    try:
        if lang_name == "python":
            import tree_sitter_python as tspython
            lang = Language(tspython.language())
        elif lang_name == "javascript":
            import tree_sitter_javascript as tsjs
            lang = Language(tsjs.language())
        elif lang_name == "typescript":
            # TypeScript grammar includes TSX support
            import tree_sitter_typescript as tsts
            lang = Language(tsts.language_typescript())
        else:
            return None
        
        _language_cache[lang_name] = lang
        return lang
    except Exception:
        return None


class TreeSitterParser(BaseParser):
    """Parse multiple languages using tree-sitter.
    
    Supports:
    - JavaScript (.js, .jsx)
    - TypeScript (.ts, .tsx)
    - Python (.py - fallback to tree-sitter if needed)
    """
    
    # Extension to language mapping
    EXT_TO_LANG = {
        ".py": "python",
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
    }
    
    def __init__(self, language_hint: str | None = None):
        """Initialize parser with optional language hint.
        
        Parameters
        ----------
        language_hint : str | None
            File extension (e.g., ".ts") to determine language
        """
        self.language_hint = language_hint
        self._parser: TSParser | None = None
        self._language: str | None = None
        
        if HAS_TREE_SITTER and language_hint:
            self._setup_parser(language_hint)
    
    def _setup_parser(self, ext: str) -> bool:
        """Setup tree-sitter parser for extension."""
        lang_name = self.EXT_TO_LANG.get(ext.lower())
        if not lang_name:
            return False
        
        lang = _get_language(lang_name)
        if lang is None:
            return False
        
        self._parser = TSParser()
        # Handle different tree-sitter API versions
        try:
            # New API (tree-sitter >= 0.22)
            self._parser.language = lang
        except (AttributeError, TypeError):
            try:
                # Old API (tree-sitter < 0.22)
                self._parser.set_language(lang)
            except AttributeError:
                # Fallback: some versions use language as constructor param
                self._parser = TSParser(language=lang)
        self._language = lang_name
        return True
    
    @property
    def language(self) -> str:
        return self._language or "unknown"
    
    def parse(self, source: str) -> ParseSnapshot:
        """Parse source using tree-sitter."""
        if not HAS_TREE_SITTER:
            return ParseSnapshot(
                source=source,
                language="unknown",
                error="tree-sitter not installed",
            )
        
        if self._parser is None:
            return ParseSnapshot(
                source=source,
                language="unknown",
                error=f"No parser available for {self.language_hint}",
            )
        
        try:
            tree = self._parser.parse(bytes(source, "utf8"))
        except Exception as e:
            return ParseSnapshot(
                source=source,
                language=self.language,
                error=str(e),
            )
        
        root = tree.root_node
        
        # Extract functions
        functions = self._extract_functions(root, source)
        
        # Extract classes
        classes = self._extract_classes(root, source)
        
        # Extract imports
        imports = self._extract_imports(root, source)
        
        # Compute LOC
        loc = self._count_loc(source)
        
        # Compute cyclomatic complexity
        cyclomatic_avg = self._compute_cyclomatic_avg(functions, root, source)
        
        return ParseSnapshot(
            source=source,
            language=self.language,
            functions=functions,
            classes=classes,
            imports=imports,
            loc=loc,
            cyclomatic_avg=cyclomatic_avg,
            halstead={},  # Halstead not yet implemented for tree-sitter
            raw_ast=tree,
        )
    
    def _extract_functions(self, root: "Tree", source: str) -> list[FunctionInfo]:
        """Extract function declarations from tree."""
        functions = []
        source_bytes = bytes(source, "utf8")
        
        # Query patterns for different languages
        query_patterns = {
            "javascript": """
                (function_declaration
                    name: (identifier) @name
                    parameters: (formal_parameters) @params) @func
                (arrow_function) @arrow
                (method_definition
                    name: (property_identifier) @name) @method
            """,
            "typescript": """
                (function_declaration
                    name: (identifier) @name
                    parameters: (formal_parameters) @params) @func
                (arrow_function) @arrow
                (method_definition
                    name: (property_identifier) @name) @method
                (function_signature) @sig
            """,
            "python": """
                (function_definition
                    name: (identifier) @name
                    parameters: (parameters) @params) @func
            """,
        }
        
        # Simple node-type based extraction (fallback)
        def walk_functions(node, depth=0):
            func_types = {
                "function_declaration", "function_definition",
                "arrow_function", "method_definition",
                "function_signature",
            }
            
            if node.type in func_types:
                name = self._extract_function_name(node, source_bytes)
                args = self._extract_parameters(node, source_bytes)
                is_async = self._is_async_function(node, source_bytes)
                
                func_info = FunctionInfo(
                    name=name or f"<anonymous@{node.start_point[0]+1}>",
                    lineno=node.start_point[0] + 1,
                    end_lineno=node.end_point[0] + 1,
                    args=args,
                    is_async=is_async,
                    complexity=1 + self._count_branches(node),
                )
                functions.append(func_info)
            
            for child in node.children:
                walk_functions(child, depth + 1)
        
        walk_functions(root)
        return functions
    
    def _extract_function_name(self, node: "Tree", source_bytes: bytes) -> str | None:
        """Extract function name from node."""
        for child in node.children:
            if child.type in ("identifier", "property_identifier"):
                return source_bytes[child.start_byte:child.end_byte].decode("utf8")
        return None
    
    def _extract_parameters(self, node: "Tree", source_bytes: bytes) -> list[str]:
        """Extract parameter names from function."""
        args = []
        for child in node.children:
            if child.type in ("formal_parameters", "parameters"):
                for param in child.children:
                    if param.type == "identifier":
                        arg_name = source_bytes[param.start_byte:param.end_byte].decode("utf8")
                        args.append(arg_name)
                    elif param.type == "required_parameter":
                        # TypeScript: required_parameter -> identifier
                        for sub in param.children:
                            if sub.type == "identifier":
                                arg_name = source_bytes[sub.start_byte:sub.end_byte].decode("utf8")
                                args.append(arg_name)
        return args
    
    def _is_async_function(self, node: "Tree", source_bytes: bytes) -> bool:
        """Check if function is async."""
        # Check for async keyword in node's text
        node_text = source_bytes[node.start_byte:node.end_byte].decode("utf8")
        return node_text.strip().startswith("async ")
    
    def _count_branches(self, node: "Tree") -> int:
        """Count branch points for complexity estimation."""
        branch_types = {
            "if_statement", "for_statement", "while_statement",
            "switch_statement", "catch_clause", "conditional_expression",
            "if_expression",  # Python
        }
        count = 0
        
        def walk(node):
            nonlocal count
            if node.type in branch_types:
                count += 1
            for child in node.children:
                walk(child)
        
        walk(node)
        return count
    
    def _extract_classes(self, root: "Tree", source: str) -> list[ClassInfo]:
        """Extract class declarations."""
        classes = []
        source_bytes = bytes(source, "utf8")
        
        def walk_classes(node):
            if node.type in ("class_declaration", "class_definition"):
                name = None
                bases = []
                
                for child in node.children:
                    if child.type in ("identifier", "type_identifier"):
                        if name is None:
                            name = source_bytes[child.start_byte:child.end_byte].decode("utf8")
                    elif child.type in ("class_heritage", "base_clause", "extends_clause", "argument_list"):
                        # Extract base classes - handle different AST structures
                        for base in child.children:
                            if base.type in ("identifier", "type_identifier", "member_expression"):
                                base_name = source_bytes[base.start_byte:base.end_byte].decode("utf8")
                                bases.append(base_name)
                            elif base.type == "extends":
                                # TypeScript: extends keyword, look for next identifier
                                continue
                            elif hasattr(base, 'children') and base.children:
                                # Nested structure - recurse
                                for sub in base.children:
                                    if sub.type in ("identifier", "type_identifier"):
                                        base_name = source_bytes[sub.start_byte:sub.end_byte].decode("utf8")
                                        bases.append(base_name)
                
                # Extract methods
                methods = []
                for child in node.children:
                    if child.type == "class_body":
                        for member in child.children:
                            if member.type == "method_definition":
                                for sub in member.children:
                                    if sub.type == "property_identifier":
                                        method_name = source_bytes[sub.start_byte:sub.end_byte].decode("utf8")
                                        methods.append(method_name)
                
                if name:
                    classes.append(ClassInfo(
                        name=name,
                        lineno=node.start_point[0] + 1,
                        bases=bases,
                        methods=methods,
                    ))
            
            for child in node.children:
                walk_classes(child)
        
        walk_classes(root)
        return classes
    
    def _extract_imports(self, root: "Tree", source: str) -> list[ImportInfo]:
        """Extract import statements."""
        imports = []
        source_bytes = bytes(source, "utf8")
        
        def walk_imports(node):
            if node.type in ("import_statement", "import_declaration"):
                # import x or import { x } from "module"
                module = None
                names = []
                
                for child in node.children:
                    if child.type == "string_fragment":
                        module = source_bytes[child.start_byte:child.end_byte].decode("utf8")
                    elif child.type == "identifier":
                        names.append(source_bytes[child.start_byte:child.end_byte].decode("utf8"))
                    elif child.type in ("import_clause", "named_imports"):
                        for sub in child.children:
                            if sub.type in ("identifier", "import_specifier"):
                                for ssub in sub.children:
                                    if ssub.type == "identifier":
                                        name = source_bytes[ssub.start_byte:ssub.end_byte].decode("utf8")
                                        names.append(name)
                
                imports.append(ImportInfo(
                    module=module,
                    names=names if names else ["*"],
                    is_from_import=module is not None,
                ))
            
            elif node.type in ("import_from_statement", "namespace_import"):
                # from x import y
                module = None
                names = []
                
                for child in node.children:
                    if child.type == "dotted_name":
                        module = source_bytes[child.start_byte:child.end_byte].decode("utf8")
                    elif child.type == "identifier" and module is None:
                        module = source_bytes[child.start_byte:child.end_byte].decode("utf8")
                
                imports.append(ImportInfo(
                    module=module,
                    names=names if names else ["*"],
                    is_from_import=True,
                ))
            
            for child in node.children:
                walk_imports(child)
        
        walk_imports(root)
        return imports
    
    def _count_loc(self, source: str) -> dict[str, int]:
        """Count lines of code (language-aware)."""
        # Use appropriate comment syntax based on language
        if self.language in ("javascript", "typescript"):
            return self.count_loc(source, comment_syntax=("//", "/*"))
        return self.count_loc(source, comment_syntax=("#", ""))
    
    def _compute_cyclomatic_avg(self, functions: list[FunctionInfo], root: "Tree", source: str) -> float:
        """Compute average cyclomatic complexity."""
        if not functions:
            return 0.0
        return sum(f.complexity for f in functions) / len(functions)